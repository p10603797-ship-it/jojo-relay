#!/usr/bin/env node
// Philip's admin key (see "Admin" in the README).
//
//   node tools/admin.mjs new --out public/admin.json [--force]
//       A new admin key: an ECDSA P-256 key pair that signs admin commands and an ECDH P-256 "box"
//       key pair that players' cards are sealed to, plus a new 12-character admin password,
//       printed ONCE (it is never written anywhere). admin.json holds the two public keys and
//       the private ones encrypted with the password (PBKDF2-SHA256, 600,000 rounds + AES-256-GCM),
//       so it is safe to publish. Publish the website after this: every page then only obeys the
//       new key (and an iPad that remembered the old admin key forgets it). --force replaces an
//       existing file (the old key and password stop working).
//   node tools/admin.mjs check --in public/admin.json
//       Does the admin password in PHORTNITE_ADMIN unlock it? (exit code 0 yes, 1 no)
//
// The password never goes on the command line (it would end up in the shell history).
// Tests only: new --iter <rounds> (100000 at least).
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ADMIN_ALPHABET, ADMIN_PASSWORD_LENGTH, ADMIN_ITER, MIN_ITER, MAX_ITER, createAdminConfig, loadConfig, unlockAdmin,
} from '../public/js/admin/keys.js';

export class AdminError extends Error {}

/** A new admin password: ADMIN_PASSWORD_LENGTH characters from ADMIN_ALPHABET (crypto.randomInt). */
export function generateAdminPassword() {
  let p = '';
  for (let i = 0; i < ADMIN_PASSWORD_LENGTH; i++) p += ADMIN_ALPHABET[randomInt(ADMIN_ALPHABET.length)];
  return p;
}

/** The password as people read it: ABCD-EFGH-JKLM (dashes don't matter when typing it). */
export function groupPassword(p) { return p.replace(/(.{4})(?=.)/g, '$1-'); }

/** Make admin.json at `out`: { password, cfg }. Refuses to replace a file unless `force`. */
export async function newAdminFile(out, { force = false, iter = ADMIN_ITER } = {}) {
  if (!out) throw new AdminError('--out <file> is required (e.g. --out public/admin.json)');
  if (fs.existsSync(out) && !force) throw new AdminError(`${out} already exists: pass --force to replace it (the old admin key and password then stop working)`);
  const password = generateAdminPassword();
  const cfg = await createAdminConfig(password, { iter });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(cfg, null, 1)}\n`);
  return { password, cfg };
}

/** Does `password` unlock the admin.json at `file`? */
export async function checkAdminFile(file, password) {
  const cfg = loadConfig(fs.readFileSync(file, 'utf8'));
  if (!cfg) throw new AdminError(`${file} is not a valid admin.json`);
  return !!(await unlockAdmin(cfg, password));
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new AdminError(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'force' || k === 'help') { opts[k] = true; continue; }
    if (k === 'password' || k.startsWith('password=')) throw new AdminError('give the admin password in PHORTNITE_ADMIN, never on the command line');
    if (!['out', 'in', 'iter'].includes(k)) throw new AdminError(`unknown option ${a}`);
    if (i + 1 >= rest.length) throw new AdminError(`${a} needs a value`);
    opts[k] = rest[++i];
  }
  return { cmd, opts };
}

const USAGE = `usage:
  node tools/admin.mjs new --out public/admin.json [--force]   a new admin key + password (printed once)
  PHORTNITE_ADMIN=… node tools/admin.mjs check --in public/admin.json
tests only: new --iter <rounds> (${MIN_ITER} at least)`;

export async function main(argv, { log = console.log, env = process.env } = {}) {
  const { cmd, opts } = parseArgs(argv);
  if (!cmd || opts.help || cmd === 'help') { log(USAGE); return 0; }
  if (cmd === 'new') {
    let iter = ADMIN_ITER;
    if (opts.iter !== undefined) {
      iter = Number(opts.iter);
      if (!Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) throw new AdminError(`--iter must be a whole number from ${MIN_ITER} to ${MAX_ITER}`);
    }
    const { password } = await newAdminFile(opts.out, { force: !!opts.force, iter });
    log(`Admin key written to ${opts.out} (public keys + the private keys encrypted; no password in it).`);
    log('');
    log('  Admin password (shown only this once: write it down, it is not saved anywhere):');
    log('');
    log(`      ${groupPassword(password)}`);
    log('');
    log('  In the game: "Admin" on the Who\'s playing? screen, then this password. It works once the');
    log('  website is published with this admin.json; from then on an older admin key no longer does.');
    return 0;
  }
  if (cmd === 'check') {
    if (!opts.in) throw new AdminError('--in <file> is required');
    const pw = env.PHORTNITE_ADMIN || '';
    if (!pw) throw new AdminError('put the admin password in the PHORTNITE_ADMIN environment variable');
    const ok = await checkAdminFile(opts.in, pw);
    log(ok ? `OK: that password unlocks ${opts.in}.` : `No: that password does not unlock ${opts.in}.`);
    return ok ? 0 : 1;
  }
  throw new AdminError(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof AdminError ? `admin: ${e.message}` : e);
    process.exitCode = 2;
  });
}
