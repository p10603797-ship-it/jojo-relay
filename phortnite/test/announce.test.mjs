// News from Philip (public/js/ui/announce.js): which banner shows for an announce.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isNewer, pickBanner } from '../public/js/ui/announce.js';
import { VERSION } from '../public/shared/constants.js';

test('announce: versions compare by number, not text', () => {
  assert.equal(isNewer('2.1.0', '2.0.2'), true);
  assert.equal(isNewer('2.10.0', '2.9.9'), true);
  assert.equal(isNewer('2.0.2', '2.0.2'), false);
  assert.equal(isNewer('2.0.1', '2.0.2'), false);
  assert.equal(isNewer('3', '2.9.9'), true);
  assert.equal(isNewer('', '2.0.0'), false);
});

test('announce: a message until it is closed; the update prompt only for a newer version and never mid-match', () => {
  const a = { message: '  Game is going to be updated by Philip soon ', id: 'soon', version: '2.0.2' };
  assert.deepEqual(pickBanner(a, { version: '2.0.2' }), { update: false, message: 'Game is going to be updated by Philip soon', id: 'soon' });
  assert.equal(pickBanner(a, { version: '2.0.2', seen: ['soon'] }).message, '', 'closed stays closed');
  assert.equal(pickBanner({ ...a, id: 'other' }, { version: '2.0.2', seen: ['soon'] }).message, 'Game is going to be updated by Philip soon', 'a new message shows again');
  assert.equal(pickBanner({ version: '2.1.0' }, { version: '2.0.2' }).update, true);
  assert.equal(pickBanner({ version: '2.1.0' }, { version: '2.0.2', inMatch: true }).update, false);
  assert.deepEqual(pickBanner(null), { update: false, message: '', id: '' });
  assert.deepEqual(pickBanner({ message: 42, version: 7 }), { update: false, message: '', id: '' });
  assert.equal(pickBanner({ message: 'x'.repeat(500) }).message.length, 200);
});

test('announce: the published announce.json is valid and matches this build', () => {
  const a = JSON.parse(fs.readFileSync(new URL('../public/announce.json', import.meta.url), 'utf8'));
  assert.equal(typeof a.version, 'string');
  assert.equal(isNewer(a.version, VERSION), false, 'announce.json never asks this build to update to itself');
  assert.equal(isNewer(VERSION, a.version), false, 'announce.json names this build, so older pages get the update prompt');
});
