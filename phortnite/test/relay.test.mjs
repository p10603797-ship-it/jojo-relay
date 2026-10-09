// The relay for P2P parties (public/js/net/mqtt.js + relay.js): when two devices can't open a
// direct WebRTC link, party messages go through an MQTT broker. Runs against a small local
// broker (helpers/minibroker.mjs) over real WebSockets, with PeerJS faked like party.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBroker } from './helpers/minibroker.mjs';
import { Mqtt } from '../public/js/net/mqtt.js';
import { RelayHost, relayDial, useBrokers, topicFor } from '../public/js/net/relay.js';
import { P2PHost, P2PClient, usePeer, frameSender, frameReceiver } from '../public/js/net/p2p.js';
import { PROTOCOL } from '../public/shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10); }
};
const hello = (name, extra = {}) => ({ name, skin: 1, v: PROTOCOL, resume: '', ...extra });
function inbox(net) { const box = []; net.onMessage((m) => box.push(m)); box.last = (t) => { for (let i = box.length - 1; i >= 0; i--) if (box[i].t === t) return box[i]; return null; }; return box; }

test('mqtt: connects with a login, hears its own messages (packets split over frames too), and a wrong login is refused', async () => {
  const b = await startBroker({ user: 'public', pass: 'public', split: true });
  try {
    const m = new Mqtt({ url: b.url, user: 'public', pass: 'public' });
    await m.connect();
    const got = [];
    await m.subscribe('a/b', (t) => got.push(t));
    m.publish('a/b', 'hello');
    m.publish('a/b', 'émoji 🎉 '.repeat(2000)); // a long message: a multi-byte length and UTF-8
    m.publish('a/c', 'not for us');
    await until(() => got.length === 2);
    assert.deepEqual(got, ['hello', 'émoji 🎉 '.repeat(2000)]);
    let closed = false;
    m.onClose = () => { closed = true; };
    b.kill();
    await until(() => closed);
    assert.equal(m.open, false);
    await assert.rejects(new Mqtt({ url: b.url, user: 'public', pass: 'nope' }).connect(), /refused/);
    await assert.rejects(new Mqtt({ url: 'ws://127.0.0.1:1/mqtt' }).connect(2000));
  } finally {
    await b.stop();
  }
});

test('relay: a friend reaches the host, messages (big ones too) go both ways in order, a 20 Hz stream goes out at most 10 times a second', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const host = new RelayHost('ABCD', (l) => { links.push(l); });
  const links = [];
  try {
    host.start();
    assert.equal(await host.whenReady(3000), true);
    const link = await relayDial('ABCD', 3000);
    await until(() => links.length === 1);
    const hl = links[0];
    const atHost = [], atFriend = [];
    hl.on('data', frameReceiver((m) => atHost.push(m)));
    link.on('data', frameReceiver((m) => atFriend.push(m)));
    const toHost = frameSender(link), toFriend = frameSender(hl);
    const big = { t: 'start', pad: 'x'.repeat(60000), name: 'Zoë 🎉' };
    toFriend(big);
    for (let i = 0; i < 5; i++) toHost({ t: 'n', i });
    await until(() => atFriend.length === 1 && atHost.length === 5);
    assert.deepEqual(atFriend[0], big);
    assert.deepEqual(atHost.map((m) => m.i), [0, 1, 2, 3, 4]);
    // 20 snapshots a second for 1.5 s: batched into ~10 broker messages a second
    const before = b.published;
    for (let i = 0; i < 30; i++) { toFriend({ t: 's', i }); await sleep(50); }
    await until(() => atFriend.filter((m) => m.t === 's').length === 30);
    const sent = b.published - before;
    assert.ok(sent <= 20, `${sent} broker messages for 30 snapshots`);
    assert.deepEqual(atFriend.filter((m) => m.t === 's').map((m) => m.i), [...Array(30).keys()]);
    // the friend hangs up: the host's end closes
    let hostClosed = false;
    hl.on('close', () => { hostClosed = true; });
    link.close();
    await until(() => hostClosed);
  } finally {
    host.stop();
    useBrokers(null);
    await sleep(250);
    await b.stop();
  }
});

test('relay: no host -> relay-nohost, no broker -> relay-offline; one broker down still links through another', async () => {
  const good = await startBroker();
  const down = await startBroker();
  await down.stop();
  try {
    useBrokers([{ url: good.url }]);
    await assert.rejects(relayDial('NOPE', 1500), (e) => e.type === 'relay-nohost');
    useBrokers([{ url: down.url }]);
    await assert.rejects(relayDial('NOPE', 3000), (e) => e.type === 'relay-offline');
    useBrokers([{ url: down.url }, { url: good.url }]);
    const links = [];
    const host = new RelayHost('WXYZ', (l) => links.push(l));
    host.start();
    assert.equal(await host.whenReady(3000), true);
    const link = await relayDial('WXYZ', 3000);
    assert.equal(link.open, true);
    await until(() => links.length === 1);
    assert.notEqual(topicFor('WXYZ'), topicFor('WXYY'));
    assert.doesNotMatch(topicFor('WXYZ'), /WXYZ/, 'the code is not on show');
    link.close();
    host.stop();
  } finally {
    useBrokers(null);
    await sleep(250);
    await good.stop();
  }
});

// ------------------------------------------------------------------ whole parties over the relay
// PeerJS stand-in where the introduction works but the direct link never opens (Wi-Fi that keeps
// devices apart): PeerJS closes the channel when its connection checks fail.
const PEERS = new Map();
let anon = 0, mode = 'ice-fails';
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
    setTimeout(() => {
      if (!PEERS.has(id)) this.fire('error', { type: 'peer-unavailable' });
      else dc.close(); // the connection checks failed
    }, 100);
    return dc;
  }
  reconnect() {}
  destroy() { if (PEERS.get(this.id) === this) PEERS.delete(this.id); }
}

test('P2P over the relay: no direct link on this Wi-Fi, the friend still joins, plays, and gets back in after the relay drops', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  usePeer(FakePeer);
  mode = 'ice-fails';
  const host = new P2PHost(hello('Mia'));
  let ben = null;
  try {
    const hb = inbox(host);
    await host.connect();
    await until(() => hb.last('welcome'));
    await until(() => host.relay.ready);
    ben = new P2PClient(host.code, hello('Ben'));
    const status = [];
    ben.onStatus = (s) => status.push(s);
    const bb = inbox(ben);
    await ben.connect();
    await until(() => bb.last('welcome'));
    assert.equal(ben.via, 'relay');
    assert.match(status.join(), /another way/);
    assert.equal(host.room.humans().length, 2);
    await until(() => ben.rtt > 0, 8000); // pings come back
    // a match over the relay
    const w = bb.last('welcome');
    ben.rejoin = () => ({ t: 'join', hello: hello('Ben', { resume: w.resume, keep: true }) });
    host.send({ t: 'start', bots: 0, mats: 0 });
    await until(() => bb.last('start'));
    // the broker drops everyone: the friend comes back as the same player
    b.kill();
    await until(() => bb.some((m) => m.t === '_net' && m.state === 'reconnecting'));
    await until(() => bb.last('resumed'), 15000);
    assert.equal(bb.last('resumed').you, w.you);
    assert.equal(host.room.players.get(w.you).away, 0);
    // the host ends the party: the friend hears it
    host.close();
    await until(() => bb.last('partyend'));
  } finally {
    if (ben) ben.close(false);
    host.close();
    useBrokers(null);
    await sleep(400);
    await b.stop();
    PEERS.clear();
  }
});

test('P2P over the relay: with the introduction service out of reach the party runs on the relay alone; clear errors when nothing works', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  usePeer(FakePeer);
  mode = 'offline';
  const host = new P2PHost(hello('Mia'));
  try {
    const hb = inbox(host);
    await host.connect();
    await until(() => hb.last('welcome'));
    assert.match(host.code, /^[A-Z]{4}$/);
    assert.equal(host.peer, undefined);
    const ben = new P2PClient(host.code, hello('Ben'));
    const bb = inbox(ben);
    await ben.connect();
    await until(() => bb.last('welcome'));
    assert.equal(ben.via, 'relay');
    ben.close();
    // a code nobody hosts
    const quick = (code) => Object.assign(new P2PClient(code, hello('Cat')), { relayMs: 1500 });
    await assert.rejects(quick('QQQQ').connect(), (e) => e.type === 'peer-unavailable' && /No party with code QQQQ/.test(e.message));
    // no internet at all
    useBrokers([]);
    await assert.rejects(quick('QQQQ').connect(), (e) => e.type === 'offline' && /internet/.test(e.message));
    await assert.rejects(new P2PHost(hello('Dan')).connect(), /internet/);
    // the party exists but neither way reaches it (a host on an old version without the relay)
    mode = 'ice-fails';
    PEERS.set('phortnite-v1-OLDV', new FakePeer('x'));
    useBrokers([{ url: b.url }]);
    await assert.rejects(quick('OLDV').connect(), (e) => e.type === 'unreachable' && /reload/.test(e.message));
  } finally {
    host.close();
    useBrokers(null);
    await sleep(400);
    await b.stop();
    PEERS.clear();
  }
});
