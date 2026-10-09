// Seams between the v2 packages (mode engine, mode catalogue, lobby party, build feel, map, bots),
// checked on the shared Room that solo, the Node server and P2P hosts all run. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from './helpers/roomharness.mjs';
import { PROTOCOL, VERSION } from '../public/shared/constants.js';
import { ruleField } from '../public/shared/modes/rules.js';
import { MODES, findMode } from '../public/shared/modes/index.js';
import { cleanSettings } from '../public/shared/plugins/party.js';
import { settingsFrom } from '../public/shared/room.js';

test('v2: PROTOCOL 3, VERSION 2.0.1 (2.0.1: relay links for P2P parties, same protocol)', () => {
  assert.equal(PROTOCOL, 3);
  assert.equal(VERSION, '2.0.1');
});

test('roles reach clients after the start (clients clear roles on start): infection, juggernaut, hide & seek', () => {
  for (const id of ['infection', 'juggernaut', 'hide-and-seek']) {
    const H = makeRoom({ drop: ['s'] });
    const a = H.join('Ann'), b = H.join('Ben');
    H.send(a, { t: 'mode', id });
    assert.equal(H.room.settings.modeId, id, `${id} can be picked`);
    H.send(a, { t: 'tweak', bots: 7 });
    H.send(a, { t: 'start' });
    const box = H.msgs(b);
    const iStart = box.findIndex((m) => m.t === 'start');
    assert.ok(iStart >= 0, `${id} started`);
    const roles = box.filter((m) => m.t === 'role');
    assert.ok(roles.length > 0, `${id}: someone has a role`);
    for (const m of roles) assert.ok(box.indexOf(m) > iStart, `${id}: role ${m.role} for ${m.id} came after the start`);
    // and they match the room's
    for (const m of roles) assert.equal(H.room.players.get(m.id).role, m.role);
    assert.deepEqual(H.errors, []);
  }
});

test('hide & seek is selectable (win option appended, catalogue entry shown)', () => {
  assert.ok(ruleField('win').options.includes('hideseek'));
  assert.equal(ruleField('win').options.at(-1), 'hideseek', 'append-only: codes store option indexes');
  assert.ok(findMode('hide-and-seek'));
  assert.ok(MODES.length >= 64);
});

test('a party of one carries its mode to a server / P2P party: rules win, legacy fields fill gaps', () => {
  const kept = { modeId: 'duos', rules: { teams: 2, bots: 11 }, bots: 3, info: { name: 'Duos' } };
  assert.equal(settingsFrom(cleanSettings(kept)).rules.bots, 11, 'rules.bots is the truth');
  assert.equal(settingsFrom(cleanSettings({ modeId: 'duos', rules: { teams: 2 }, bots: 3 })).rules.bots, 3, 'mirror bots fill a gap');
});

test('Zero Build: the room refuses edits too (bots and players alike)', async () => {
  const { pieceKey, EDIT_PRESETS } = await import('../public/shared/buildgrid.js');
  const { BUILD } = await import('../public/shared/constants.js');
  const { getWorld } = await import('../public/shared/room.js');
  const w = getWorld(), C = BUILD.cell;
  // a flat, open land cell
  let S = null;
  for (let cx = -40; cx <= 40 && !S; cx++) {
    for (let cz = -40; cz <= 40 && !S; cz++) {
      const x = cx * C + C / 2, z = cz * C + C / 2, y = w.heightAt(x, z);
      if (y < 2 || y > 3.2) continue;
      if (Math.abs(w.heightAt(x + C, z) - y) > 0.3 || Math.abs(w.heightAt(x, z + C) - y) > 0.3) continue;
      if (w.solidNear(x, y + 1, z) || w.solidNear(x, y + 1, z + C)) continue;
      S = { cx, cz, x, z, y };
    }
  }
  assert.ok(S, 'a flat cell');
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'mode', custom: { bots: 0, spawn: 'ground', storm: 'none' }, name: 'T' });
  H.send(a, { t: 'start' });
  const at = (c, x, z) => H.send(c, { t: 'u', s: [x, S.y + 0.1, z, 0, 0, 0, 0, 0, 0, 'pickaxe', 0] });
  H.advance(100);
  at(a, S.x, S.z);
  const k = pieceKey('w', S.cx, 0, S.cz + 1, 'x');
  H.send(a, { t: 'b', k, m: 'wood' });
  assert.ok(H.room.grid.get(k), 'built');
  H.advance(200);
  H.room.rules.build = 'off';
  H.clear(b);
  H.send(a, { t: 'be', k, e: EDIT_PRESETS.w.door });
  assert.equal(H.msgs(b, 'be').length, 0, 'refused in Zero Build');
  H.room.rules.build = 'on';
  H.advance(200);
  H.send(a, { t: 'be', k, e: EDIT_PRESETS.w.door });
  assert.equal(H.last(b, 'be').e, EDIT_PRESETS.w.door, 'allowed with building on');
  assert.deepEqual(H.errors, []);
});

test('a reloaded page gets its mode loadout back with the rejoin (gun game rung)', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann', { resume: '' }), b = H.join('Ben', { resume: '' });
  const token = H.last(b, 'welcome').resume;
  H.send(a, { t: 'mode', id: 'gun-game' });
  H.send(a, { t: 'tweak', bots: 0 });
  H.send(a, { t: 'start' });
  H.advance(500);
  const p = H.player(b.pid);
  assert.ok(p.lo && p.lo.slots.length, 'gun game gives a loadout');
  H.leave(b);
  const b2 = H.join('Ben', { resume: token });
  const w = H.last(b2, 'welcome');
  assert.equal(w.resumed, true);
  assert.deepEqual(w.me.lo, p.lo);
  assert.deepEqual(H.errors, []);
});
