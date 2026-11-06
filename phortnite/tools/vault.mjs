#!/usr/bin/env node
// The locked save: the game's source is kept on the public repository, but encrypted.
//
// The repository is public, and Philip wants the newest code hidden. So new work is saved as a git
// bundle (the commits after a public base commit), encrypted with AES-256-GCM under a key stretched
// from the ADMIN password (PBKDF2-HMAC-SHA256, 600,000 rounds, a random salt per save). The file
// says nothing about the code without that password; with it, `open` brings the commits back into
// any clone of the repository (the base commit is public, so the bundle only needs what came after).
//
//   PHORTNITE_ADMIN=… node tools/vault.mjs seal --base <commit> [--ref work] --out vault/source.vault
//       the commits from <commit> (not included) up to <ref>, encrypted. The password is checked
//       against public/admin.json first, so a typo can't make a save nobody can open.
//   PHORTNITE_ADMIN=… node tools/vault.mjs open --in vault/source.vault [--ref work]
//       decrypts it and fetches the saved branch into refs/heads/<ref> (refuses to overwrite one
//       that already exists: delete or rename it first).
//
// File layout: "PHVAULT1" | rounds (uint32 BE) | salt (16) | iv (12) | ciphertext | GCM tag (16).
// The first 40 bytes (magic, rounds, salt, iv) are the GCM additional data, so they can't be changed.
// The password only comes from PHORTNITE_ADMIN, never from the command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkAdminFile } from './admin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAGIC = Buffer.from('PHVAULT1');
const HEAD_LEN = MAGIC.length + 4 + 16 + 12;
export const VAULT_ITER = 600000;

export class VaultError extends Error {}

function deriveKey(password, salt, iter) {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iter, 32, 'sha256');
}

/** Encrypt bytes with the password. */
export function sealBytes(plain, password, { iter = VAULT_ITER } = {}) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const rounds = Buffer.alloc(4);
  rounds.writeUInt32BE(iter);
  const head = Buffer.concat([MAGIC, rounds, salt, iv]);
  const c = createCipheriv('aes-256-gcm', deriveKey(password, salt, iter), iv);
  c.setAAD(head);
  return Buffer.concat([head, c.update(plain), c.final(), c.getAuthTag()]);
}

/** Decrypt bytes made by sealBytes (throws VaultError on a wrong password or a damaged file). */
export function openBytes(file, password) {
  if (file.length < HEAD_LEN + 16 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new VaultError('not a vault file');
  const head = file.subarray(0, HEAD_LEN);
  const iter = head.readUInt32BE(MAGIC.length);
  if (iter < 1 || iter > 10_000_000) throw new VaultError('not a vault file');
  const salt = head.subarray(MAGIC.length + 4, MAGIC.length + 20);
  const iv = head.subarray(MAGIC.length + 20, HEAD_LEN);
  const d = createDecipheriv('aes-256-gcm', deriveKey(password, salt, iter), iv);
  d.setAAD(head);
  d.setAuthTag(file.subarray(file.length - 16));
  try {
    return Buffer.concat([d.update(file.subarray(HEAD_LEN, file.length - 16)), d.final()]);
  } catch {
    throw new VaultError('wrong password, or the file is damaged');
  }
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phvault-')), name);
}

export async function seal({ base, ref = 'work', out, password, cwd = ROOT, adminFile = path.join(ROOT, 'public/admin.json'), iter = VAULT_ITER }) {
  if (!base || !out) throw new VaultError('--base and --out are required');
  if (!password) throw new VaultError('put the admin password in the PHORTNITE_ADMIN environment variable');
  if (adminFile && !(await checkAdminFile(adminFile, password))) throw new VaultError(`that password does not unlock ${adminFile}: not saving with it`);
  const head = git(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  git(['merge-base', '--is-ancestor', base, ref], cwd);
  const bundle = tmpFile('source.bundle');
  try {
    git(['bundle', 'create', bundle, `refs/heads/${ref}`, `^${base}`], cwd);
    const sealed = sealBytes(fs.readFileSync(bundle), password, { iter });
    fs.mkdirSync(path.dirname(path.resolve(cwd, out)), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, out), sealed);
    return { head, bytes: sealed.length };
  } finally {
    fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
  }
}

export async function open({ file, ref = 'work', password, cwd = ROOT }) {
  if (!file) throw new VaultError('--in is required');
  if (!password) throw new VaultError('put the admin password in the PHORTNITE_ADMIN environment variable');
  const plain = openBytes(fs.readFileSync(path.resolve(cwd, file)), password);
  let exists = true;
  try { git(['rev-parse', '--verify', `refs/heads/${ref}`], cwd); } catch { exists = false; }
  if (exists) throw new VaultError(`branch ${ref} already exists: delete or rename it first`);
  const bundle = tmpFile('source.bundle');
  try {
    fs.writeFileSync(bundle, plain);
    git(['bundle', 'verify', bundle], cwd);
    const heads = git(['bundle', 'list-heads', bundle], cwd).split('\n').filter(Boolean);
    if (heads.length !== 1) throw new VaultError(`expected one branch in the save, found ${heads.length}`);
    const [, saved] = heads[0].split(' ');
    git(['fetch', '--no-tags', bundle, `${saved}:refs/heads/${ref}`], cwd);
    return { head: git(['rev-parse', `refs/heads/${ref}`], cwd) };
  } finally {
    fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new VaultError(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'help') { opts.help = true; continue; }
    if (k === 'password' || k.startsWith('password=')) throw new VaultError('give the admin password in PHORTNITE_ADMIN, never on the command line');
    if (!['base', 'ref', 'out', 'in'].includes(k)) throw new VaultError(`unknown option ${a}`);
    if (i + 1 >= rest.length) throw new VaultError(`${a} needs a value`);
    opts[k] = rest[++i];
  }
  return { cmd, opts };
}

const USAGE = `usage:
  PHORTNITE_ADMIN=… node tools/vault.mjs seal --base <commit> [--ref work] --out vault/source.vault
  PHORTNITE_ADMIN=… node tools/vault.mjs open --in vault/source.vault [--ref work]`;

export async function main(argv, { log = console.log, env = process.env } = {}) {
  const { cmd, opts } = parseArgs(argv);
  if (!cmd || opts.help || cmd === 'help') { log(USAGE); return 0; }
  const password = env.PHORTNITE_ADMIN || '';
  if (cmd === 'seal') {
    const { head, bytes } = await seal({ base: opts.base, ref: opts.ref, out: opts.out, password });
    log(`Saved ${opts.ref || 'work'} (${head.slice(0, 7)}) to ${opts.out}: ${(bytes / 1048576).toFixed(1)} MB, locked with the admin password.`);
    return 0;
  }
  if (cmd === 'open') {
    const { head } = await open({ file: opts.in, ref: opts.ref, password });
    log(`Opened ${opts.in}: branch ${opts.ref || 'work'} is at ${head.slice(0, 7)}.`);
    return 0;
  }
  throw new VaultError(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof VaultError ? `vault: ${e.message}` : e);
    process.exitCode = 2;
  });
}
