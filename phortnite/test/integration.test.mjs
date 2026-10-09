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

test('v2: PROTOCOL 3, VERSION 2.0.0', () => {
  assert.equal(PROTOCOL, 3);
  assert.equal(VERSION, '2.0.0');
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
