// Game plugin (js/game/plugins.js): the party chat as a Game hears it. The room's chat plugin
// (shared/plugins/chat.js) sends
//   {t: 'chat', id, name, text, ts, q?, admin?}   a line, to everyone in the party (observers too)
//   {t: 'chatno', why}                            to a sender whose line it dropped ('slow')
//   welcome / resumed {chat: [lines]}             the party's newest lines, for joiners and rejoins
// Everything goes on to the page's chat (app.chat, js/ui/chat.js), which keeps the lines (all
// parties, this page load), draws the drawer and the in-match feed, and tells its listeners
// (app.chat.onLine) about new lines; a welcome's history is kept but never announced as new.
// No imports: game plugins load in Node too (the contract tests).
export class ChatClient {
  constructor(game) {
    this.game = game;
  }

  get chat() {
    const app = this.game && this.game.app;
    return (app && app.chat) || null;
  }

  onMessage(m) {
    const c = this.chat;
    if (!c || !m) return;
    if (m.t === 'chat') c.receive(this.game, m);
    else if (m.t === 'chatno') c.refused(this.game, m);
    else if (m.t === 'welcome' || m.t === 'resumed') c.joined(this.game, Array.isArray(m.chat) ? m.chat : []);
    else if (m.t === 'roster') c.rosterChanged(this.game);
  }

  onPhase(phase) {
    const c = this.chat;
    if (c) c.phaseChanged(this.game, phase);
  }

  dispose() {
    const c = this.chat;
    if (c) c.left(this.game);
  }
}
