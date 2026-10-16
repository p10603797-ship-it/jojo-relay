// The live player count (public/js/net/presence.js): everyone with the game open, counted over a
// public MQTT broker. Runs against the small local broker (helpers/minibroker.mjs) over real
// WebSockets, with every timing shrunk so a 'refresh every 2 minutes' takes well under a second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBroker } from './helpers/minibroker.mjs';
import { Mqtt } from '../public/js/net/mqtt.js';
import { useBrokers } from '../public/js/net/relay.js';
import { Presence, PRESENCE_PREFIX } from '../public/js/net/presence.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, what = '') => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`timed out ${what}`); await sleep(10); }
};
const FAST = { refreshMs: 600, perPlayerMs: 0, staleMin: 1500, minGapMs: 0, hideMs: 150, tickMs: 50, settleMs: 150, notifyMs: 20, backoffMs: 50, maxBackoffMs: 400, connectMs: 2000 };
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
// refreshing every minute: whoever is counted after a mishap is counted because of the fix, not a refresh
const SLOW = { ...FAST, refreshMs: 60000, staleMin: 180000 };
const fresh = (s = 'l') => JSON.stringify({ s, t: now() });

/** A plain MQTT client for poking the broker the way some other page (or a prankster) would. */
async function poker(b) {
  const m = new Mqtt({ url: b.url });
  await m.connect(3000);
  return m;
}

test('presence: everyone sees the same count; a clean stop leaves at once; a page that vanishes goes with its will', async () => {
  const b = await startBroker({ user: 'public', pass: 'public' });
  useBrokers([{ url: b.url, user: 'public', pass: 'public' }]);
  const seen = [];
  // (STALE 5 s here: whoever goes within a second went by a message, not the sweep)
  const T = { ...FAST, staleMin: 5000 };
  const p1 = new Presence({ ...T, state: () => 'm' });
  const p2 = new Presence({ ...T });
  // p3 stays away a long while once dropped (an iPad that lost its Wi-Fi)
  const p3 = new Presence({ ...T, backoffMs: 60000, maxBackoffMs: 60000 });
  p1.onChange((c) => seen.push(c));
  try {
    assert.match(p1.id, /^[a-z0-9]{12}$/);
    assert.notEqual(p1.id, p2.id);
    for (const p of [p1, p2, p3]) assert.equal(p.start(), true);
    await until(() => [p1, p2, p3].every((p) => p.online && p.counts.total === 3), 6000, 'all three counted');
    assert.deepEqual(p1.counts, { total: 3, inMatch: 1, inLobby: 2, online: true });
    assert.deepEqual(p2.counts, { total: 3, inMatch: 1, inLobby: 2, online: true });
    await until(() => seen.length && seen[seen.length - 1].total === 3, 2000, 'onChange');
    // what the broker keeps: one small retained message each, nothing else about anyone
    const kept = [...b.retained].filter(([t]) => t.startsWith(PRESENCE_PREFIX));
    assert.equal(kept.length, 3);
    for (const [, v] of kept) assert.deepEqual(Object.keys(JSON.parse(v)).sort(), ['s', 't']);
    // a clean stop: gone at once (long before anyone would sweep it as stale)
    const t0 = Date.now();
    p2.stop();
    await until(() => p1.counts.total === 2 && p3.counts.total === 2, 1000, 'p2 gone');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(b.retained.has(PRESENCE_PREFIX + p2.id), false);
    assert.equal(p2.online, false);
    // p3's connection drops without a goodbye: the broker publishes its will (an empty retained message)
    b.drop(p3.m.id);
    await until(() => p1.counts.total === 1, 1000, 'p3 gone via its will');
    assert.equal(b.retained.has(PRESENCE_PREFIX + p3.id), false);
    assert.equal(p3.online, false);
    assert.deepEqual(p1.counts, { total: 1, inMatch: 1, inLobby: 0, online: true });
    await until(() => seen[seen.length - 1].total === 1, 2000);
  } finally {
    for (const p of [p1, p2, p3]) p.stop();
    useBrokers(null);
    await b.stop();
  }
});

test('presence: lobby and match counts follow each page going in and out of matches', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  let s1 = 'l';
  const p1 = new Presence({ ...FAST, state: () => s1 });
  const p2 = new Presence({ ...FAST });
  const p3 = new Presence({ ...FAST, state: () => 'm' });
  let p4 = null;
  try {
    for (const p of [p1, p2, p3]) p.start();
    await until(() => [p1, p2, p3].every((p) => p.online && p.counts.total === 3));
    assert.deepEqual(p2.counts, { total: 3, inMatch: 1, inLobby: 2, online: true });
    s1 = 'm';
    p1.update(); // (main.js calls it when the stage toggles; the tick would notice anyway)
    assert.equal(p1.counts.inMatch, 2, 'your own count changes at once');
    await until(() => p2.counts.inMatch === 2 && p3.counts.inMatch === 2, 2000, 'into a match');
    assert.equal(p2.counts.inLobby, 1);
    s1 = 'l'; // back to the lobby, noticed by the tick
    await until(() => p2.counts.inMatch === 1 && p3.counts.inLobby === 2, 2000, 'back in the lobby');
    // refreshed every refreshMs (±10%): a few messages each, not a flood
    const before = b.published;
    await sleep(2000);
    const sent = b.published - before;
    assert.ok(sent >= 6 && sent <= 15, `${sent} refreshes from 3 pages in 2 s`);
    assert.equal(p2.counts.total, 3, 'refreshing keeps everyone counted past STALE');
    // someone new arrives: their first count already has everyone (no '1 PLAYING' flash)
    p4 = new Presence({ ...FAST });
    const first = [];
    p4.onChange((c) => { if (c.online) first.push(c.total); });
    p4.start();
    await until(() => first.length > 0);
    assert.equal(first[0], 4);
  } finally {
    for (const p of [p1, p2, p3, p4]) if (p) p.stop();
    useBrokers(null);
    await b.stop();
  }
});

test('presence: ghosts, junk and floods do not count; whoever stops refreshing is swept', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const x = await poker(b);
  const p = new Presence({ ...FAST });
  let q = null;
  try {
    const P = PRESENCE_PREFIX;
    x.publish(`${P}ghost1`, JSON.stringify({ s: 'l', t: now() - 3600 }), { retain: true }); // its will got lost an hour ago
    x.publish(`${P}ghost2`, JSON.stringify({ s: 'l', t: now() - 2 * DAY }), { retain: true }); // …two days ago
    x.publish(`${P}fresh1`, fresh('m'), { retain: true });
    for (const [id, text] of [['badjson1', 'nope'], ['badstate1', JSON.stringify({ s: 'x', t: now() })], ['notime1', '{"s":"l"}'],
      ['UPPER', fresh()], ['a'.repeat(25), fresh()], ['has-dash', fresh()], ['arr1', '[1,2]'], ['nul1', 'null']]) {
      x.publish(P + id, text, { retain: true });
    }
    x.publish(`${P}deep/er`, fresh(), { retain: true }); // not one level: the '+' filter never sees it
    await sleep(100);
    p.start();
    await until(() => p.online);
    await sleep(100);
    assert.deepEqual(p.counts, { total: 2, inMatch: 1, inLobby: 1, online: true }, 'you + fresh1');
    assert.equal(b.retained.has(`${P}ghost2`), false, 'the ghost dead for days was cleared off the broker');
    assert.equal(b.retained.has(`${P}ghost1`), true, 'an hour is not counted, but not cleared either (a clock can be that far off)');
    assert.equal(b.retained.has(`${P}fresh1`), true);
    // live messages: the same rules
    x.publish(`${P}live1`, fresh());
    x.publish(`${P}BAD`, fresh());
    x.publish(`${P}live2`, '{"s":');
    await until(() => p.counts.total === 3);
    await sleep(100);
    assert.equal(p.counts.total, 3);
    x.publish(`${P}live1`, '', { retain: true }); // left
    await until(() => p.counts.total === 2);
    // someone heard once and never again (a ghost from a broker hiccup): swept after STALE (3
    // refreshes); so is fresh1, which was only ever a retained message
    x.publish(`${P}once1`, fresh());
    await until(() => p.counts.total === 3);
    const t0 = Date.now();
    await until(() => p.counts.total === 1, 5000, 'once1 swept');
    const took = Date.now() - t0;
    assert.ok(took > 1200, `swept after ${took} ms (STALE is 1.8 s here)`);
    assert.equal(p.online, true);
    // a flood: never more than max people kept
    q = new Presence({ ...FAST, max: 5 });
    for (let i = 0; i < 12; i++) x.publish(`${P}flood${i}`, fresh(), { retain: true });
    await sleep(100);
    q.start();
    await until(() => q.online);
    for (let i = 12; i < 20; i++) x.publish(`${P}flood${i}`, fresh());
    await sleep(200);
    assert.equal(q.counts.total, 6, '5 kept + you');
    assert.equal(q.peers.size, 5);
  } finally {
    p.stop();
    if (q) q.stop();
    x.close();
    useBrokers(null);
    await b.stop();
  }
});

test('presence: off with ?relay=off; off screen for a while leaves and comes back; reconnects after the broker drops', async () => {
  useBrokers([]);
  const off = new Presence({ ...FAST });
  assert.equal(off.start(), false);
  assert.equal(off.off, true);
  assert.equal(off.online, false);
  off.stop();
  const down = await startBroker();
  await down.stop();
  const b = await startBroker();
  // the first broker that answers, in order
  useBrokers([{ url: down.url }, { url: b.url }]);
  const p1 = new Presence({ ...FAST });
  const p2 = new Presence({ ...FAST });
  try {
    p1.start();
    p2.start();
    await until(() => p1.online && p2.online && p1.counts.total === 2 && p2.counts.total === 2);
    assert.equal(p1.m.server.url, b.url);
    // a quick app switch: still counted
    p2.hidden(true);
    await sleep(60);
    p2.hidden(false);
    await sleep(200);
    assert.equal(p2.online, true);
    assert.equal(p1.counts.total, 2);
    // off screen longer than hideMs: leaves (and hangs up)
    p2.hidden(true);
    await until(() => p1.counts.total === 1, 2000, 'p2 left while hidden');
    assert.equal(p2.online, false);
    assert.equal(p2.m, null);
    await sleep(200);
    assert.equal(p2.m, null, 'stays away while hidden');
    // back on screen: counted again
    p2.hidden(false);
    await until(() => p2.online && p1.counts.total === 2 && p2.counts.total === 2, 3000, 'p2 back');
    // the page goes away (pagehide): gone at once
    p2.leave();
    await until(() => p1.counts.total === 1, 1000);
    p2.hidden(false); // back from the back/forward cache
    await until(() => p1.counts.total === 2 && p2.online, 3000);
    // the broker drops everyone: both come back (with a fresh snapshot), counts the same
    const states = [];
    p1.onChange((c) => states.push(c.online));
    b.kill();
    await until(() => !p1.online, 2000);
    await until(() => p1.online && p2.online && p1.counts.total === 2 && p2.counts.total === 2, 5000, 'reconnected');
    await until(() => states[states.length - 1] === true, 1000, 'the lobby hears it is back');
    assert.ok(states.includes(false), 'the lobby heard it was offline meanwhile');
    // timings: refresh max(2 min, N s), stale 3 refreshes (at least 6 min)
    const d = new Presence();
    assert.equal(d.refreshMs(1), 120000);
    assert.equal(d.refreshMs(500), 500000);
    assert.equal(d.staleMs(1), 360000);
    assert.equal(d.staleMs(500), 1500000);
  } finally {
    p1.stop();
    p2.stop();
    useBrokers(null);
    await b.stop();
  }
});

test('presence: a will spoken late (after the page reconnected) does not make the page vanish', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const p1 = new Presence({ ...SLOW });
  const p2 = new Presence({ ...SLOW });
  try {
    p1.start();
    p2.start();
    await until(() => p1.online && p2.online && p1.counts.total === 2 && p2.counts.total === 2);
    // p2's connection dies (Wi-Fi roaming); p2 reconnects at once, and the broker speaks the old
    // connection's will (an empty retained message on p2's topic) only after that
    const old = p2.m;
    let heard = 0;
    p1.onChange(() => heard++);
    b.drop(old.id, { lateWillMs: 400 });
    await until(() => p2.online && p2.m && p2.m !== old, 2000, 'p2 reconnected');
    const sent = b.published;
    await sleep(700); // the late will has gone out
    assert.equal(b.retained.has(PRESENCE_PREFIX + p2.id), true, 'p2 said it again: newcomers count it');
    assert.ok(b.published - sent >= 1, 'p2 answered its own deletion');
    await until(() => p1.counts.total === 2, 1000, 'p1 counts p2 again');
    const p3 = new Presence({ ...SLOW });
    p3.start();
    await until(() => p3.online, 3000);
    assert.equal(p3.counts.total, 3, 'a newcomer counts everyone');
    p3.stop();
    // its own goodbyes (stop, leave) don't make it say it again
    await until(() => p1.counts.total === 2, 1000);
    p2.leave();
    await until(() => p1.counts.total === 1, 1000);
    await sleep(200);
    assert.equal(b.retained.has(PRESENCE_PREFIX + p2.id), false);
    assert.ok(heard > 0);
  } finally {
    p1.stop();
    p2.stop();
    useBrokers(null);
    await b.stop();
  }
});

test('presence: a device whose clock is days off never takes live players off the count', async () => {
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const P = PRESENCE_PREFIX;
  const p1 = new Presence({ ...SLOW });
  const p2 = new Presence({ ...SLOW });
  const ps = [p1, p2];
  // who gets deleted (an empty message), seen from the side
  const x = await poker(b);
  const deleted = [];
  await x.subscribe(`${P}+`, (text, topic) => { if (!text) deleted.push(topic.slice(P.length)); });
  try {
    p1.start();
    p2.start();
    await until(() => p1.online && p2.online && p1.counts.total === 2);
    // an iPad whose date was set two days ahead: everyone looks long dead to it, so it clears nobody
    const fast = new Presence({ ...SLOW, clock: () => Date.now() + 2 * DAY * 1000 });
    ps.push(fast);
    fast.start();
    await until(() => fast.online, 3000);
    await sleep(200);
    assert.deepEqual(deleted, []);
    assert.equal(b.retained.has(P + p1.id), true);
    assert.equal(b.retained.has(P + p2.id), true);
    assert.equal(p1.counts.total, 3, 'p1 still counts p2 (and the fast one)');
    // one set two days back: newcomers take its message for a ghost and clear it; it hears that and
    // says it again, so it stays counted
    const slow = new Presence({ ...SLOW, clock: () => Date.now() - 2 * DAY * 1000 });
    ps.push(slow);
    slow.start();
    await until(() => slow.online && p1.counts.total === 4, 3000, 'slow counted');
    const p5 = new Presence({ ...SLOW });
    ps.push(p5);
    p5.start();
    await until(() => p5.online, 3000);
    await sleep(300);
    assert.ok(deleted.includes(slow.id), 'the newcomer cleared the slow one (it looked dead for days)');
    assert.equal(b.retained.has(P + slow.id), true, 'the slow one is back on the broker');
    assert.equal(p1.counts.total, 5);
    assert.equal(p5.counts.total, 5, 'and the newcomer counts it (it said it again)');
  } finally {
    for (const p of ps) p.stop();
    x.close();
    useBrokers(null);
    await b.stop();
  }
});

test('presence: a page that had to use a fallback broker goes back to the first one when it answers', async () => {
  const down = await startBroker();
  const port = +new URL(down.url).port;
  await down.stop();
  const b2 = await startBroker();
  useBrokers([{ url: down.url }, { url: b2.url }]);
  const H = { ...SLOW, homeMs: 200 };
  const p1 = new Presence(H);
  const p2 = new Presence(H);
  let b1 = null;
  try {
    p1.start();
    await until(() => p1.online, 3000);
    assert.equal(p1.m.server.url, b2.url, 'the first broker is down: the second one');
    await sleep(400); // tries the first one again meanwhile (still down): stays on the second
    assert.equal(p1.online, true);
    assert.equal(p1.m.server.url, b2.url);
    b1 = await startBroker({ port }); // the first one is back
    p2.start();
    await until(() => p2.online, 3000);
    assert.equal(p2.m.server.url, b1.url);
    await until(() => p1.m && p1.m.server.url === b1.url, 3000, 'p1 back on the first broker');
    await until(() => p1.counts.total === 2 && p2.counts.total === 2, 3000, 'both count each other');
    assert.equal(p1.online, true);
    assert.equal(b2.retained.has(PRESENCE_PREFIX + p1.id), false, 'left the fallback cleanly');
    assert.equal(b2.clients().length, 0);
  } finally {
    p1.stop();
    p2.stop();
    useBrokers(null);
    await b2.stop();
    if (b1) await b1.stop();
  }
});
