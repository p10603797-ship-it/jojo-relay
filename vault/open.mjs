#!/usr/bin/env node
// Opens one of Phortnite's locked saves and brings its branches back into this git repository.
//
// Each .vault file next to this one is a git bundle encrypted with AES-256-GCM, under a key made from
// the admin password with PBKDF2-HMAC-SHA256 (the number of rounds and a random salt are in the
// file). Without the password the files say nothing about the code.
//
//   read -rs PHORTNITE_ADMIN && export PHORTNITE_ADMIN    (type the admin password, then Enter)
//   node vault/open.mjs vault/history.vault
//
// The password can be typed with or without its dashes, in capitals or not. It is read only from
// PHORTNITE_ADMIN, never from the command line, so it doesn't end up in the shell's history.
//
// Every branch in the save is fetched under its own name. When this repository already has that name
// at another commit, the saved commit is fetched under refs/saved/<file>/<name> instead and printed,
// so nothing here is overwritten and nothing in the save is skipped.
//
// File layout: "PHVAULT1" | rounds (uint32 BE) | salt (16) | iv (12) | ciphertext | GCM tag (16).
// The first 40 bytes are the GCM additional data, so they can't be changed either.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';

const MAGIC = Buffer.from('PHVAULT1');
const HEAD_LEN = MAGIC.length + 4 + 16 + 12;

// The admin password is shown as XXXX-XXXX-XXXX, and people may type it without dashes or in small
// letters. A save was sealed with one exact spelling, so each likely spelling is tried in turn.
function spellings(typed) {
  const bare = typed.toUpperCase().replace(/[\s-]+/g, '');
  const grouped = bare.length === 12 ? `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8)}` : bare;
  return [...new Set([typed, typed.trim(), grouped, bare])].filter(Boolean);
}

function decrypt(file, typed) {
  if (file.length < HEAD_LEN + 16 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a vault file');
  const head = file.subarray(0, HEAD_LEN);
  const rounds = head.readUInt32BE(MAGIC.length);
  if (rounds < 1 || rounds > 10_000_000) throw new Error('not a vault file');
  const salt = head.subarray(MAGIC.length + 4, MAGIC.length + 20);
  const iv = head.subarray(MAGIC.length + 20, HEAD_LEN);
  for (const password of spellings(typed)) {
    const d = createDecipheriv('aes-256-gcm', pbkdf2Sync(Buffer.from(password, 'utf8'), salt, rounds, 32, 'sha256'), iv);
    d.setAAD(head);
    d.setAuthTag(file.subarray(file.length - 16));
    try {
      return Buffer.concat([d.update(file.subarray(HEAD_LEN, file.length - 16)), d.final()]);
    } catch {
      // not this spelling
    }
  }
  throw new Error('wrong password, or the file is damaged');
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commitAt(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return '';
  }
}

const file = process.argv[2];
if (!file || file.startsWith('-')) {
  console.log('usage: node vault/open.mjs <file.vault>   (with the admin password in PHORTNITE_ADMIN)');
  process.exit(file ? 2 : 0);
}
const password = process.env.PHORTNITE_ADMIN || '';
if (!password) {
  console.error('vault: put the admin password in the PHORTNITE_ADMIN environment variable (read -rs PHORTNITE_ADMIN && export PHORTNITE_ADMIN)');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phvault-'));
try {
  const bundle = path.join(tmp, 'save.bundle');
  fs.writeFileSync(bundle, decrypt(fs.readFileSync(file), password));
  try {
    git(['bundle', 'verify', bundle]);
  } catch (e) {
    // A newer save only holds the commits after an older one, which has to be opened first.
    const why = String(e.stderr || '');
    throw new Error(/prerequisite/i.test(why) ? 'this save builds on history.vault: open that one first' : why.trim() || e.message);
  }
  const name = path.basename(file).replace(/\.vault$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
  const heads = git(['bundle', 'list-heads', bundle]).split('\n').filter(Boolean).map((line) => line.split(' '));
  for (const [sha, ref] of heads) {
    const have = commitAt(ref);
    if (have === sha) {
      console.log(`${ref}: already here`);
      continue;
    }
    let into = have ? `refs/saved/${name}/${ref.replace(/^refs\//, '')}` : ref;
    const there = have ? commitAt(into) : '';
    if (there === sha) {
      console.log(`${ref}: already here as ${into}`);
      continue;
    }
    if (there) into += `-${sha.slice(0, 7)}`;
    git(['fetch', '--quiet', '--no-tags', bundle, `${ref}:${into}`]);
    console.log(have ? `${ref}: ${sha.slice(0, 7)}, fetched as ${into} (${ref} is at ${have.slice(0, 7)} here)` : `${ref}: ${sha.slice(0, 7)}`);
  }
} catch (e) {
  console.error(`vault: ${e.message}`);
  process.exitCode = 2;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
