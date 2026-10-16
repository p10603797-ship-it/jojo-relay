// Relay encryption (public/js/net/relay.js + the plain-link rules in p2p.js): party messages that go
// through the public MQTT brokers are end-to-end encrypted, so anyone subscribed to everything sees
// keys and ciphertext only. Older pages still hear "everyone should reload", never a welcome in
// clear. Runs against the local broker (helpers/minibroker.mjs), PeerJS faked like relay.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBroker } from './helpers/minibroker.mjs';
import { Mqtt } from '../public/js/net/mqtt.js';
import { RelayHost, relayDial, useBrokers, useCrypto, topicFor, SEALED_BATCH } from '../public/js/net/relay.js';
import { P2PHost, P2PClient, usePeer, frameSender, frameReceiver } from '../public/js/net/p2p.js';
import { PROTOCOL } from '../public/shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10); }
};
const hello = (name, extra = {}) => ({ name, skin: 1, v: PROTOCOL, resume: '', ...extra });
function inbox(net) { const box = []; net.onMessage((m) => box.push(m)); box.last = (t) => { for (let i = box.length - 1; i >= 0; i--) if (box[i].t === t) return box[i]; return null; }; return box; }
const MARK = 'SECRET-MARKER-7Q';
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/**
 * Nothing in clear: every body is base64 (keys, ciphertext) or empty, so no JSON (no quotes) and no
 * marker (it has a '-'); topics carry no name or party code. (Short names like "Mia" turn up inside
 * random base64 now and then, so they are looked for where text could be plain, not in ciphertext.)
 */
function assertSealed(seen, names) {
  for (const [topic, p] of seen) {
    const body = p.slice(11);
    assert.ok(!p.includes(MARK) && !p.includes('"'), `plain text on the broker: ${p.slice(0, 80)}`);
    assert.match(body, B64, `not base64: ${p.slice(0, 80)}`);
    for (const n of names) assert.ok(!topic.includes(n), `${n} in the topic ${topic}`);
  }
}

/** Everything the broker carries, as a listener on '#' sees it: [topic, payload]. */
async function spyOn(b) {
  const spy = new Mqtt({ url: b.url });
  await spy.connect();
  const seen = [];
  await spy.subscribe('#', (text, topic) => seen.push([topic, text]));
  return { spy, seen };
}

// PeerJS stand-in: 'offline' (the introduction service can't be reached: the relay only) or
// 'ice-fails' (introduced, but the direct link never opens)
const PEERS = new Map();
let anon = 0, mode = 'offline';
class FakeChannel {
  constructor() { this.h = {}; this.open = false; }
  on(ev, fn) { (this.h[ev] || (this.h[ev] = [])).push(fn); }
  fire(ev, a) { for (const fn of this.h[ev] || []) fn(a); }
  send() {}
  close() { this.fire('close'); }
}
class FakePeer {
  constructor(id, opts) {
    if (typeof id === 'object') { opts = id; id = null; }
    this.id = id || `anon${++anon}`;
    this.h = {};
    setImmediate(() => {
      if (mode === 'offline') { this.fire('error', { type: 'network', message: 'Lost connection to server.' }); return; }
      if (PEERS.has(this.id)) { this.fire('error', { type: 'unavailable-id' }); return; }
      PEERS.set(this.id, this);
      this.fire('open');
    });
  }
  on(ev, fn) { (this.h[ev] || (this.h[ev] = [])).push(fn); }
  once(ev, fn) { const w = (a) => { this.h[ev] = this.h[ev].filter((x) => x !== w); fn(a); }; this.on(ev, w); }
  fire(ev, a) { for (const fn of [...(this.h[ev] || [])]) fn(a); }
  connect(id) {
    const dc = new FakeChannel();
    setTimeout(() => { if (!PEERS.has(id)) this.fire('error', { type: 'peer-unavailable' }); else dc.close(); }, 100);
    return dc;
  }
  reconnect() {}
  destroy() { if (PEERS.get(this.id) === this) PEERS.delete(this.id); }
}

test('relay crypto: a listener on # sees keys and ciphertext only; frames keep their order through bursts both ways; sealed messages stay within the batch size', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const { spy, seen } = await spyOn(b);
  const links = [];
  const host = new RelayHost('SPYS', (l) => links.push(l));
  let link = null;
  try {
    host.start();
    assert.equal(await host.whenReady(3000), true);
    link = await relayDial('SPYS', 3000);
    await until(() => links.length === 1);
    const hl = links[0];
    assert.equal(link.plain, false);
    assert.equal(hl.plain, false);
    // the knock and the answer each carry a raw P-256 public key (65 bytes, base64), nothing else
    const base = topicFor('SPYS');
    const knock = seen.find(([t, p]) => t === `${base}/h` && p[10] === 'k');
    const answer = seen.find(([t, p]) => t === `${base}/c/${link.id}` && p[10] === 'a');
    for (const [, p] of [knock, answer]) {
      const key = Buffer.from(p.slice(11), 'base64');
      assert.equal(key.length, 65);
      assert.equal(key[0], 4);
    }
    assert.notEqual(knock[1].slice(11), answer[1].slice(11));
    // bursts both ways: small and big messages (split into frames by p2p.js), names with emoji
    const atHost = [], atFriend = [];
    hl.on('data', frameReceiver((m) => atHost.push(m)));
    link.on('data', frameReceiver((m) => atFriend.push(m)));
    const toHost = frameSender(link), toFriend = frameSender(hl);
    const N = 300;
    const msg = (i) => ({ t: 'chat', i, name: 'Zoë 🎉', text: `${MARK} ${i}`, pad: i % 50 === 7 ? `${MARK}é🎉`.repeat(3000) : 'x'.repeat((i * 37) % 900) });
    for (let i = 0; i < N; i++) { toFriend(msg(i)); toHost(msg(i)); }
    await until(() => atFriend.length === N && atHost.length === N, 20000);
    assert.deepEqual(atFriend.map((m) => m.i), [...Array(N).keys()]);
    assert.deepEqual(atHost.map((m) => m.i), [...Array(N).keys()]);
    assert.deepEqual(atFriend[57], msg(57));
    assert.deepEqual(atHost[107], msg(107));
    // and more after a pause (the order chain carries on)
    toHost({ t: 'chat', i: N, text: `${MARK} last` });
    await until(() => atHost.length === N + 1);
    // the friend hangs up: the host hears it after the data before it
    let closed = false;
    hl.on('close', () => { closed = true; });
    toHost({ t: 'bye', text: MARK });
    link.close();
    await until(() => closed);
    assert.equal(atHost[atHost.length - 1].t, 'bye', 'the data before the close arrived first');
    await sleep(100);
    // what the listener saw: no marker, no name, every data message base64 within the batch size
    assert.ok(seen.length > 20);
    let data = 0;
    for (const [topic, p] of seen) {
      assert.ok(topic.startsWith(base), topic);
      assert.ok(!p.includes(MARK) && !p.includes('Zoë') && !p.includes('"t"'), `plain text on the broker: ${p.slice(0, 80)}`);
      if (p[10] === 'd') {
        data++;
        assert.match(p.slice(11), B64);
        assert.ok(p.length <= 11 + 16000, `${p.length} characters`);
        assert.ok(Buffer.from(p.slice(11), 'base64').length >= 12 + 16);
      }
    }
    assert.ok(data >= 4);
    assert.ok(SEALED_BATCH > 11000 && Math.ceil((SEALED_BATCH + 12 + 8 + 16) / 3) * 4 <= 16000);
  } finally {
    if (link) link.close();
    host.stop();
    spy.close();
    useBrokers(null);
    await sleep(250);
    await b.stop();
  }
});

test('relay crypto: junk with a link\'s id is ignored, a bad key gets no answer, a link from before a reload is hung up', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const links = [];
  const host = new RelayHost('JUNK', (l) => links.push(l));
  const raw = new Mqtt({ url: b.url });
  let link = null;
  try {
    host.start();
    assert.equal(await host.whenReady(3000), true);
    link = await relayDial('JUNK', 3000);
    await until(() => links.length === 1);
    const hl = links[0];
    const got = [];
    hl.on('data', (f) => got.push(f));
    await raw.connect();
    const base = topicFor('JUNK');
    // someone who saw the link id publishes data for it: not sealed by the friend, so nothing
    raw.publish(`${base}/h`, `${link.id}dnot base64 at all`);
    raw.publish(`${base}/h`, `${link.id}d${Buffer.alloc(80, 7).toString('base64')}`);
    raw.publish(`${base}/h`, `${link.id}d{"t":"chat","text":"plain"}`);
    link.send('{"t":"real"}');
    await until(() => got.length === 1);
    await sleep(200);
    assert.deepEqual(got, ['{"t":"real"}']);
    assert.equal(hl.open, true);
    // a knock whose "key" isn't one: no answer, and the host keeps nothing for it
    const answers = [];
    await raw.subscribe(`${base}/c/zzzzzzzzzz`, (t) => answers.push(t));
    raw.publish(`${base}/h`, 'zzzzzzzzzzkAAAA');
    raw.publish(`${base}/h`, `zzzzzzzzzzk${Buffer.alloc(65, 9).toString('base64')}`);
    await sleep(400);
    assert.deepEqual(answers, []);
    assert.equal(host.links.has('zzzzzzzzzz'), false);
    // data from a link the host doesn't know: hang up so it knocks again
    raw.publish(`${base}/h`, 'zzzzzzzzzzdxyz');
    await until(() => answers.includes('zzzzzzzzzzx'));
  } finally {
    if (link) link.close();
    host.stop();
    raw.close();
    useBrokers(null);
    await sleep(250);
    await b.stop();
  }
});

test('relay crypto: a sealed message published again by someone on the broker is dropped (each direction numbers its messages)', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const { spy, seen } = await spyOn(b);
  const links = [];
  const host = new RelayHost('RPLY', (l) => links.push(l));
  let link = null;
  try {
    host.start();
    assert.equal(await host.whenReady(3000), true);
    link = await relayDial('RPLY', 3000);
    await until(() => links.length === 1);
    const hl = links[0];
    const atHost = [], atFriend = [];
    hl.on('data', (f) => atHost.push(f));
    link.on('data', (f) => atFriend.push(f));
    const base = topicFor('RPLY');
    // one sealed message each way
    link.send('{"t":"chat","text":"i like pizza"}');
    hl.send('{"t":"welcome","you":2}');
    await until(() => atHost.length === 1 && atFriend.length === 1);
    const toHost = seen.filter(([tp, p]) => tp === `${base}/h` && p[10] === 'd').map(([, p]) => p);
    const toFriend = seen.filter(([tp, p]) => tp === `${base}/c/${link.id}` && p[10] === 'd').map(([, p]) => p);
    assert.equal(toHost.length, 1);
    assert.equal(toFriend.length, 1);
    // someone who saw them publishes them again (no key needed): neither end takes them twice
    for (let i = 0; i < 3; i++) { spy.publish(`${base}/h`, toHost[0]); spy.publish(`${base}/c/${link.id}`, toFriend[0]); }
    await sleep(300);
    assert.deepEqual(atHost, ['{"t":"chat","text":"i like pizza"}']);
    assert.deepEqual(atFriend, ['{"t":"welcome","you":2}']);
    // the link carries on, and a message sent before the replay still can't come back after newer ones
    link.send('{"t":"chat","text":"second"}');
    await until(() => atHost.length === 2);
    spy.publish(`${base}/h`, toHost[0]);
    await sleep(200);
    assert.deepEqual(atHost, ['{"t":"chat","text":"i like pizza"}', '{"t":"chat","text":"second"}']);
    assert.equal(hl.open && link.open, true);
  } finally {
    if (link) link.close();
    host.stop();
    spy.close();
    useBrokers(null);
    await sleep(250);
    await b.stop();
  }
});

test('P2P over the relay: names, the welcome and chat never cross the broker in clear', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  usePeer(FakePeer);
  mode = 'ice-fails';
  const { spy, seen } = await spyOn(b);
  const host = new P2PHost(hello('Mia'));
  let ben = null;
  try {
    const hb = inbox(host);
    await host.connect();
    await until(() => hb.last('welcome'));
    await until(() => host.relay.ready);
    ben = new P2PClient(host.code, hello('Benjamin'));
    const bb = inbox(ben);
    await ben.connect();
    await until(() => bb.last('welcome'));
    assert.equal(ben.via, 'relay');
    assert.equal(ben.plainRelay, false);
    // chat both ways
    ben.send({ t: 'chat', text: `hello ${MARK}` });
    await until(() => hb.some((m) => m.t === 'chat'));
    assert.equal(hb.last('chat').name, 'Benjamin');
    assert.equal(hb.last('chat').text, `hello ${MARK}`);
    host.send({ t: 'chat', text: `hi ${MARK} back` });
    await until(() => bb.some((m) => m.t === 'chat' && /back/.test(m.text)));
    assert.equal(bb.last('chat').name, 'Mia');
    // a match starts (a big message)
    host.send({ t: 'start', bots: 0, mats: 0 });
    await until(() => bb.last('start'));
    // the admin's pause stops the room clock, not chat: its limits and ts run on the room's wall clock
    host.pause();
    const n0 = host.room.now(), w0 = host.room.wall();
    await sleep(40);
    assert.equal(host.room.now(), n0);
    assert.ok(host.room.wall() >= w0 + 30);
    ben.send({ t: 'chat', text: 'why is it paused?' });
    await until(() => bb.some((m) => m.t === 'chat' && m.text === 'why is it paused?'));
    assert.ok(bb.last('chat').ts > w0, 'ts from the clock that runs on');
    host.resume();
    await sleep(300);
    // the spy heard the whole conversation (how many messages depends on the batching)
    const base = topicFor(host.code);
    const kinds = (t) => seen.filter(([topic]) => topic === t || topic.startsWith(`${t}/`)).map(([, p]) => p[10]);
    assert.ok(kinds(`${base}/h`).includes('k') && kinds(`${base}/h`).includes('d'), 'the friend\'s knock and data');
    assert.ok(kinds(`${base}/c`).includes('a') && kinds(`${base}/c`).includes('d'), 'the host\'s answer and data');
    assertSealed(seen, ['Benjamin', 'Mia', host.code]);
  } finally {
    if (ben) ben.close(false);
    host.close();
    spy.close();
    useBrokers(null);
    await sleep(400);
    await b.stop();
    PEERS.clear();
  }
});

test('relay crypto: a knock without a key (an older page) is answered plain, and the host only tells it to reload', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  usePeer(FakePeer);
  mode = 'offline';
  const { spy, seen } = await spyOn(b);
  const host = new P2PHost(hello('Mia'));
  const old = new Mqtt({ url: b.url });
  try {
    const hb = inbox(host);
    await host.connect();
    await until(() => hb.last('welcome') && host.relay.ready);
    await old.connect();
    const base = topicFor(host.code);
    /** An older page: knocks without a key, sends its join in clear. Returns what it heard. */
    const oldPage = async (id, join) => {
      const heard = [];
      await old.subscribe(`${base}/c/${id}`, (t) => heard.push(t));
      old.publish(`${base}/h`, `${id}k`);
      await until(() => heard.includes(`${id}a`));
      old.publish(`${base}/h`, `${id}d${JSON.stringify(join)}`);
      await until(() => heard.some((t) => t[10] === 'd'));
      await until(() => heard.includes(`${id}x`), 3000); // and the host hangs up
      return heard.filter((t) => t[10] === 'd').map((t) => JSON.parse(t.slice(11)));
    };
    // a different version: the Room's own "everyone should reload"
    const v = await oldPage('old0000001', { t: 'join', hello: { name: 'Oldie', v: PROTOCOL - 1 } });
    assert.equal(v.length, 1);
    assert.equal(v[0].t, 'err');
    assert.equal(v[0].ver, true);
    assert.match(v[0].msg, /reload/);
    // the same version, but no key (a page that can't encrypt): told why, still no welcome
    const s = await oldPage('old0000002', { t: 'join', hello: { name: 'Same', v: PROTOCOL } });
    assert.equal(s.length, 1);
    assert.equal(s[0].t, 'err');
    assert.equal(s[0].ver, true);
    assert.match(s[0].msg, /can't be kept private/);
    assert.equal(host.room.humans().length, 1, 'nobody joined over a plain link');
    assert.ok(!seen.some(([, p]) => p.includes('"welcome"') || p.includes('"players"')), 'no welcome in clear');
  } finally {
    host.close();
    old.close();
    spy.close();
    useBrokers(null);
    await sleep(400);
    await b.stop();
    PEERS.clear();
  }
});

test('relay crypto: a friend whose answer came without a key (an older host page) sends a bare hello and refuses a welcome', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  usePeer(FakePeer);
  mode = 'offline';
  const fake = new Mqtt({ url: b.url });
  const clients = [];
  try {
    await fake.connect();
    /** An older host page for code: answers knocks without a key, then says reply(join) in clear. */
    const oldHost = async (code, reply) => {
      const base = topicFor(code);
      const got = { knocks: [], joins: [] };
      await fake.subscribe(`${base}/h`, (t) => {
        const id = t.slice(0, 10), kind = t[10], body = t.slice(11);
        if (kind === 'k') { got.knocks.push(body); fake.publish(`${base}/c/${id}`, `${id}a`); }
        if (kind === 'd') {
          for (const f of body.split('\n')) {
            const m = JSON.parse(f);
            if (m.t !== 'join') continue;
            got.joins.push(m);
            fake.publish(`${base}/c/${id}`, `${id}d${JSON.stringify(reply(m))}`);
          }
        }
      });
      return got;
    };
    // it sends a welcome anyway: turned away with a clear error, the welcome never reaches the game
    const w = await oldHost('OLDH', () => ({ t: 'welcome', v: PROTOCOL, you: 2, code: 'OLDH', players: [] }));
    const ben = new P2PClient('OLDH', hello('Benjamin', { resume: 'ABCDEFGHJKLMNPQR' }));
    clients.push(ben);
    const bb = inbox(ben);
    let closedWith;
    ben.onClose = (m) => { closedWith = m; };
    await ben.connect();
    assert.equal(ben.via, 'relay');
    assert.equal(ben.plainRelay, true);
    await until(() => bb.last('err'));
    const err = bb.last('err');
    assert.equal(err.ver, true);
    assert.match(err.msg, /older version/);
    assert.match(err.msg, /reload/);
    assert.equal(bb.last('welcome'), null);
    await until(() => bb.some((m) => m.t === '_net' && m.state === 'lost'));
    assert.equal(closedWith, err);
    assert.equal(ben.closed, true);
    // the knock carried a key; the join over the plain link was bare (no name, no resume token)
    assert.equal(Buffer.from(w.knocks[0], 'base64').length, 65);
    assert.deepEqual(w.joins, [{ t: 'join', hello: { v: PROTOCOL } }]);
    // an older host's version message gets through as it is
    await oldHost('OLDE', () => ({ t: 'err', ver: true, msg: 'Phortnite was updated, and this page is on a different version than your friends. Everyone should reload the page, then try again.' }));
    const cat = new P2PClient('OLDE', hello('Cat'));
    clients.push(cat);
    const cb = inbox(cat);
    await cat.connect();
    await until(() => cb.last('err'));
    assert.match(cb.last('err').msg, /Phortnite was updated/);
    assert.equal(cb.last('welcome'), null);
  } finally {
    for (const c of clients) c.close(false);
    fake.close();
    useBrokers(null);
    await sleep(300);
    await b.stop();
    PEERS.clear();
  }
});

test('relay crypto: pages without WebCrypto knock without a key and get "can\'t be kept private", never the party', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  usePeer(FakePeer);
  mode = 'offline';
  const { spy, seen } = await spyOn(b);
  const host = new P2PHost(hello('Mia'));
  let ben = null;
  try {
    const hb = inbox(host);
    await host.connect();
    await until(() => hb.last('welcome') && host.relay.ready);
    useCrypto(false);
    ben = new P2PClient(host.code, hello('Benjamin'));
    const bb = inbox(ben);
    await ben.connect();
    assert.equal(ben.plainRelay, true);
    await until(() => bb.last('err'));
    assert.equal(bb.last('err').ver, true);
    assert.match(bb.last('err').msg, /can't be kept private/);
    assert.equal(host.room.humans().length, 1);
    assert.ok(!seen.some(([, p]) => p.includes('Benjamin')), 'the bare hello has no name');
  } finally {
    useCrypto(true);
    if (ben) ben.close(false);
    host.close();
    spy.close();
    useBrokers(null);
    await sleep(400);
    await b.stop();
    PEERS.clear();
  }
});

test('relay crypto: a host page going away hangs up at once, even with data still being sealed', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const links = [];
  const host = new RelayHost('BYEB', (l) => links.push(l));
  try {
    host.start();
    assert.equal(await host.whenReady(3000), true);
    const link = await relayDial('BYEB', 3000);
    await until(() => links.length === 1);
    let closed = false;
    link.on('close', () => { closed = true; });
    const hl = links[0];
    for (let i = 0; i < 40; i++) hl.send(JSON.stringify({ i, pad: 'z'.repeat(5000) }));
    // what pagehide does (P2PHost.onPageHide): the 'x' goes out now, not after the seals
    const published = b.published;
    host.hangUpAll();
    assert.equal(hl.open, false);
    await until(() => closed, 2000);
    assert.ok(b.published > published);
  } finally {
    host.stop();
    useBrokers(null);
    await sleep(250);
    await b.stop();
  }
});
