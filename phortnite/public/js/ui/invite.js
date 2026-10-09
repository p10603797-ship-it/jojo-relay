// Invites, one flow for both transports:
//   INVITE  a party of one becomes a hosted party first (static website: this device hosts it
//           peer-to-peer; Node server page: the server hosts it), keeping the mode you picked,
//           then the sheet shows a giant code (tap to copy), a QR code, SHARE and COPY LINK.
//   JOIN    four big letter boxes, plus the server's 'Parties nearby' list (updated in place, so a
//           tap is never lost to a refresh).
//   #join=CODE links join directly: on a server page through the server (falling back to
//           peer-to-peer when the server has no such party), on the website peer-to-peer.
// Every new connection waits for the party's welcome before the lobby switches over, so a failed
// join leaves you in your own party with a toast.
import { WsNet } from '../net/net.js';
import { P2PHost, P2PClient, qrDataUrl } from '../net/p2p.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CODE_RE = /^[A-Z]{4}$/;

/**
 * Wait for the party's welcome on a new connection. kickoff() connects / sends the join. Resolves
 * with { buf, off }: every message so far (welcome included); the listener stays until off(), so
 * nothing that arrives before the Game takes over is lost. Rejects on 'err' or after ms.
 */
export function awaitWelcome(net, kickoff, ms = 12000) {
  return new Promise((resolve, reject) => {
    const buf = [];
    let done = false;
    const off = net.onMessage((m) => {
      buf.push(m);
      if (done) return;
      if (m.t === 'welcome' || m.t === 'resumed') { done = true; clearTimeout(timer); resolve({ buf, off }); } else if (m.t === 'err') fail(Object.assign(new Error(m.msg || 'Could not join that party.'), { ver: !!m.ver, noParty: /^No party/.test(m.msg || '') }));
    });
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('The party did not answer. Check the code and try again.')), ms);
    Promise.resolve().then(kickoff).catch(fail);
  });
}

/** The settings a new party starts with (the mode the party of one picked). */
export function keepSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of ['modeId', 'rules', 'info', 'custom', 'bots', 'botSkill', 'mats', 'mode']) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

export class Invite {
  constructor(app) {
    this.app = app;
    this.info = null;
    this.busy = false;
  }

  isServer() { return !!document.documentElement.dataset.server; }

  async serverInfo() {
    if (this.info || !this.isServer()) return this.info;
    try { this.info = await (await fetch('api/info', { cache: 'no-store' })).json(); } catch (e) { this.info = null; }
    return this.info;
  }

  /** The invite link: this page's address (the LAN address when this page is on localhost) + #join=CODE. */
  async link(code) {
    let base = `${location.origin}${location.pathname}`;
    if (this.isServer() && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      const info = await this.serverInfo();
      if (info && info.lanUrl) base = info.lanUrl;
    }
    return `${base}#join=${code}`;
  }

  /** INVITE: open a party (when still a party of one), then show the invite sheet. */
  async openInvite() {
    const app = this.app;
    if (this.busy) return;
    if (app.partyKind() === 'solo') {
      app.ui.modal('<h2>INVITE FRIENDS</h2><p class="inv-wait"><i class="spin"></i> Opening your party…</p>');
      this.busy = true;
      try {
        await this.host();
      } catch (e) {
        app.ui.closeModal();
        app.lobby.toast(esc(e.message || 'Could not open a party.'), { kind: 'bad' });
        return;
      } finally {
        this.busy = false;
      }
    }
    this.sheet();
  }

  /** Turn the party of one into a hosted party (server page: the server; website: this device). */
  async host() {
    const app = this.app;
    const settings = keepSettings(app.game && app.game.settingsState);
    let net, res;
    try {
      if (this.isServer()) {
        net = new WsNet(app.wsUrl());
        res = await awaitWelcome(net, async () => { await net.connect(); net.send({ t: 'create', hello: app.hello(), settings }); });
      } else {
        net = new P2PHost(app.hello(), { settings });
        res = await awaitWelcome(net, () => net.connect(), 25000);
      }
    } catch (e) {
      try { net && net.close(false); } catch (e2) { /* */ }
      throw e;
    }
    app.enterParty(net, { replay: res.buf, off: res.off });
  }

  async sheet() {
    const app = this.app;
    const g = app.game;
    if (!g || app.partyKind() === 'solo') return;
    const code = g.code;
    const url = await this.link(code);
    const canShare = typeof navigator.share === 'function';
    app.ui.modal(`<h2>INVITE FRIENDS</h2>
      <div class="inv-wrap">
        <div class="inv-left">
          <div class="inv-label">PARTY CODE <small>(tap to copy)</small></div>
          <button class="inv-code" aria-label="Copy the party code">${esc(code)}</button>
          <div class="inv-hint">Friends tap <b>JOIN A FRIEND</b> and type the code, or scan the QR code with the iPad camera. Works with friends anywhere${this.isServer() ? ' that can reach this server' : ''}. Keep the game open on screen while they join.</div>
          <div class="inv-btns">
            ${canShare ? '<button class="btn yellow big inv-share">📤 SHARE</button>' : ''}
            <button class="btn ${canShare ? '' : 'yellow '}big inv-copy">🔗 COPY LINK</button>
          </div>
          <div class="inv-url">${esc(url)}</div>
        </div>
        <div class="inv-qr"><img alt="QR code for the invite link"></div>
      </div>`, (b) => {
      const img = $('.inv-qr img', b);
      img.addEventListener('error', () => { img.parentNode.classList.add('none'); });
      if (this.isServer()) img.src = `api/qr.svg?u=${encodeURIComponent(url)}`;
      else qrDataUrl(url).then((src) => { if (src) img.src = src; else img.parentNode.classList.add('none'); });
      const copy = (text, what) => {
        const ok = () => app.lobby.toast(`${what} copied!`);
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => this.selectUrl(b));
        else this.selectUrl(b);
      };
      $('.inv-code', b).addEventListener('click', () => { app.sfx.ui(); copy(code, 'Party code'); });
      $('.inv-copy', b).addEventListener('click', () => { app.sfx.ui(); copy(url, 'Invite link'); });
      const sh = $('.inv-share', b);
      if (sh) sh.addEventListener('click', () => {
        app.sfx.ui();
        navigator.share({ title: 'Join my Phortnite party!', text: `Join my Phortnite party! Code ${code}`, url }).catch(() => {});
      });
    });
  }

  selectUrl(b) {
    const el = $('.inv-url', b);
    if (!el) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    this.app.lobby.toast('Press and hold the link to copy it');
  }

  /** JOIN A FRIEND: four letter boxes, and on a server the parties nearby. */
  openJoin() {
    const app = this.app;
    const server = this.isServer();
    let lister = null, timer = 0;
    const rows = new Map(); // code -> li (updated in place: taps are never lost to a refresh)
    app.ui.modal(`<h2>JOIN A FRIEND</h2>
      <p class="jn-sub">Type your friend's 4-letter party code</p>
      <div class="jn-boxes">${[0, 1, 2, 3].map((i) => `<input class="jn-box" data-i="${i}" maxlength="1" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" inputmode="text" aria-label="Letter ${i + 1}">`).join('')}</div>
      <div class="sheet-btns"><button class="btn yellow big jn-go" disabled>JOIN</button></div>
      ${server ? '<h3>Parties nearby</h3><ul class="jn-list"><li class="jn-empty">Looking for parties…</li></ul>' : ''}`, (b) => {
      const boxes = [...b.querySelectorAll('.jn-box')];
      const go = $('.jn-go', b);
      const code = () => boxes.map((x) => x.value).join('');
      const refresh = () => { go.disabled = !CODE_RE.test(code()); };
      const submit = () => {
        const c = code();
        if (!CODE_RE.test(c)) return;
        app.ui.closeModal();
        this.join(c);
      };
      boxes.forEach((box, i) => {
        box.addEventListener('input', () => {
          const letters = box.value.toUpperCase().replace(/[^A-Z]/g, '');
          if (letters.length > 1) {
            // pasted or typed fast: spread over the boxes
            for (let k = 0; k < letters.length && i + k < 4; k++) boxes[i + k].value = letters[k];
            boxes[Math.min(3, i + letters.length)].focus();
          } else {
            box.value = letters;
            if (letters && i < 3) boxes[i + 1].focus();
          }
          refresh();
          if (CODE_RE.test(code())) setTimeout(submit, 250);
        });
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; refresh(); }
          if (e.key === 'Enter') submit();
        });
        box.addEventListener('focus', () => box.select());
      });
      go.addEventListener('click', () => { app.sfx.ui(); submit(); });
      boxes[0].focus();
      if (server) {
        const list = $('.jn-list', b);
        const render = (rooms) => {
          const mine = app.game && app.partyKind() !== 'solo' ? app.game.code : '';
          rooms = rooms.filter((r) => r.code !== mine);
          const seen = new Set();
          for (const r of rooms) {
            seen.add(r.code);
            let li = rows.get(r.code);
            if (!li) {
              li = document.createElement('li');
              li.innerHTML = '<span class="nm"></span><span class="badge">SAME WI-FI</span><span class="meta"></span><button class="btn yellow jn-row">JOIN</button>';
              $('.jn-row', li).addEventListener('click', () => { app.sfx.ui(); app.ui.closeModal(); this.join(r.code); });
              rows.set(r.code, li);
              list.appendChild(li);
            }
            li.querySelector('.nm').textContent = r.name;
            li.querySelector('.badge').style.display = r.sameNet ? '' : 'none';
            li.querySelector('.meta').textContent = `${r.players}/${r.max} · ${r.phase === 'lobby' ? 'in the lobby' : 'match running'} · ${r.code}`;
          }
          for (const [c, li] of rows) if (!seen.has(c)) { li.remove(); rows.delete(c); }
          const empty = $('.jn-empty', list);
          if (empty) empty.style.display = rows.size ? 'none' : '';
          if (empty && !rows.size) empty.textContent = 'No other parties on this server yet.';
        };
        lister = new WsNet(app.wsUrl());
        lister.onMessage((m) => { if (m.t === 'rooms') render(m.rooms); });
        lister.connect().then(() => {
          lister.send({ t: 'list' });
          timer = setInterval(() => lister.send({ t: 'list' }), 3000);
        }).catch(() => { const e = $('.jn-empty', list); if (e) e.textContent = 'Could not reach the server.'; });
      }
    }, () => {
      clearInterval(timer);
      if (lister) lister.close(false);
    });
  }

  /**
   * Join a party by code. opts: { fromLink (a #join link: a server page falls back to P2P when
   * the server has no such party), kind ('server' | 'p2p' to force one), resume (token after a
   * reload), quiet }.
   */
  async join(code, opts = {}) {
    const app = this.app;
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!CODE_RE.test(code)) { app.lobby.toast('Party codes are 4 letters, like ABCD.', { kind: 'bad' }); return false; }
    if (app.game && app.partyKind() !== 'solo' && app.game.code === code) { app.lobby.toast('You are already in that party!'); return true; }
    if (this.busy) return false;
    this.busy = true;
    app.lobby.netStatus(opts.resume ? 'Getting you back into your party…' : `Joining party ${code}…`);
    const hello = app.hello(opts.resume ? { resume: opts.resume } : {});
    let net = null, res = null;
    try {
      if (this.isServer() && opts.kind !== 'p2p') {
        try {
          net = new WsNet(app.wsUrl());
          res = await awaitWelcome(net, async () => { await net.connect(); net.send({ t: 'join', code, hello }); });
        } catch (e) {
          try { net && net.close(false); } catch (e2) { /* */ }
          net = null;
          if (!(e.noParty && (opts.fromLink || opts.kind === 'p2p'))) throw e;
        }
      }
      if (!res) {
        net = new P2PClient(code, hello);
        // e.g. 'Trying another way to reach your friend…' when the Wi-Fi won't link the iPads directly
        net.onStatus = (text) => app.lobby.netStatus(text);
        res = await awaitWelcome(net, () => net.connect(), 25000);
        net.onStatus = null;
      }
      const w = res.buf.find((m) => m.t === 'welcome' || m.t === 'resumed');
      app.enterParty(net, { replay: res.buf, off: res.off });
      if (!opts.quiet) app.lobby.toast(`🎉 You joined <b>${esc(w && w.name ? w.name : `party ${code}`)}</b>!`);
      return true;
    } catch (e) {
      try { net && net.close(false); } catch (e2) { /* */ }
      if (e && e.ver) app.ui.alert(e.message);
      else app.lobby.toast(esc((e && e.message) || 'Could not join that party.'), { kind: 'bad', ms: 9000 });
      return false;
    } finally {
      this.busy = false;
      app.lobby.netStatus('');
    }
  }
}
