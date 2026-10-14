// Game plugin (js/game/plugins.js): the admin as a party sees it.
//  - party commands: the host's room sends {t: 'admin', env} (env: the admin's signed envelope) when
//    it ends, pauses or changes the mode on the admin's say-so; the page's AdminClient
//    (js/admin/client.js) checks the signature and tells the player.
//  - the admin watching (stage E): the room tells everyone how many observers there are
//    (welcome.obs, {t: 'obs', n}); while there is one, a chip says "👁 Admin is watching". Moderation
//    is open: nobody is ever watched without seeing it.
//  - on the admin's own watching page (game.observer) the observer view (app.adminWatch,
//    js/ui/adminWatch.js) hears the party's messages and draws its bar every frame.
// No imports: game plugins load in Node too (the contract tests).
export class AdminNotes {
  constructor(game) {
    this.game = game;
    this.watched = 0; // observers in this party (0: nobody is watching)
  }

  get client() { return (this.game.app && this.game.app.adminClient) || null; }

  get watch() {
    const app = this.game.app;
    return this.game.observer && app && app.adminWatch ? app.adminWatch : null;
  }

  onMessage(m) {
    if (m.t === 'admin') {
      const c = this.client;
      if (c) c.onRoomMessage(m, this.game);
    } else if (m.t === 'welcome' || m.t === 'resumed') this.setWatched(m.obs);
    else if (m.t === 'obs') this.setWatched(m.n);
    const w = this.watch;
    if (w) w.onMessage(m, this.game);
  }

  /** n observers now: the "Admin is watching" chip on (n > 0) or off. Not on the admin's own watching page. */
  setWatched(n) {
    const v = this.game.observer ? 0 : Math.max(0, Math.min(9, n | 0));
    if (v === this.watched) return;
    this.watched = v;
    this.game.watchedBy = v;
    const c = this.client;
    if (c) c.chip('watch', v ? '👁 Admin is watching' : null);
    else if (v && this.game.hud && this.game.hud.notice) this.game.hud.notice('👁 Admin is watching', false, 5);
  }

  hud(dt) {
    const w = this.watch;
    if (w) w.frame(this.game, dt);
  }

  onPhase(phase) {
    // the match is over (or never was): an admin pause ends with it
    const c = this.client;
    if (c && phase === 'lobby') c.setPaused(false);
  }

  dispose() {
    // a party left: its chip goes with it (and the observer bar with the watched party)
    const w = this.watch;
    if (w) w.bar(false);
    this.setWatched(0);
  }
}
