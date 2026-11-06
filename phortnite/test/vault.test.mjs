// The locked save (tools/vault.mjs): encrypt the newest commits with the admin password, open them again.
// Saves here use 1,000 PBKDF2 rounds so the tests are quick; real ones use 600,000.
// Every password in this file is made up for the tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sealBytes, openBytes, seal, open, VaultError } from '../tools/vault.mjs';

const ITER = 1000;
const PW = 'TEST-PASS-WORD';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'public\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('sealBytes/openBytes: round trip, wrong password and tampering are refused', () => {
  const plain = Buffer.from('secret source code');
  const file = sealBytes(plain, PW, { iter: ITER });
  assert.equal(file.subarray(0, 8).toString(), 'PHVAULT1');
  assert.ok(!file.includes(plain), 'the plain text is not in the file');
  assert.deepEqual(openBytes(file, PW), plain);
  assert.throws(() => openBytes(file, 'WRONG-PASS-WORD'), VaultError);
  const bad = Buffer.from(file);
  bad[bad.length - 20] ^= 1;
  assert.throws(() => openBytes(bad, PW), VaultError);
  const badHead = Buffer.from(file);
  badHead[20] ^= 1;
  assert.throws(() => openBytes(badHead, PW), VaultError);
  assert.throws(() => openBytes(Buffer.from('nope'), PW), VaultError);
});

test('seal + open: the commits after the base come back in a fresh clone', async () => {
  const src = repo();
  const base = git(src, 'rev-parse', 'HEAD');
  git(src, 'checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(src, 'b.txt'), 'hidden\n');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'new work');
  const head = git(src, 'rev-parse', 'HEAD');
  const out = path.join(src, 'vault', 'source.vault');
  await seal({ base, ref: 'work', out, password: PW, cwd: src, adminFile: null, iter: ITER });
  assert.ok(!fs.readFileSync(out).includes(Buffer.from('hidden')));

  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-clone-'));
  git(dst, 'clone', '-q', '--no-local', '--single-branch', '--branch', 'main', src, '.');
  assert.throws(() => git(dst, 'cat-file', '-e', `${head}^{commit}`), 'the clone does not have the new commit yet');
  await assert.rejects(open({ file: out, ref: 'work', password: 'WRONG-PASS-WORD', cwd: dst }), VaultError);
  const got = await open({ file: out, ref: 'work', password: PW, cwd: dst });
  assert.equal(got.head, head);
  assert.equal(git(dst, 'show', 'work:b.txt'), 'hidden');
  await assert.rejects(open({ file: out, ref: 'work', password: PW, cwd: dst }), /already exists/);
});
