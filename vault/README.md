# Phortnite's locked save

Philip's game Phortnite is kept here encrypted. Nothing in this branch can be read without the
admin password: since 15 November 2026 no branch of this repository holds the game's code readable.

- `history.vault`: every branch of the game with its whole history up to 15 November 2026,
  every old version included.
- `old-site.vault`: the website's old history, with every version that was ever published.
- `source.vault`: the newest save. It is written again every 15 minutes while work goes on and
  holds what came after Phortnite 2.6.0, so `history.vault` has to be opened first.

Each file is a git bundle encrypted with AES-256-GCM, under a key made from the admin password
(PBKDF2-SHA256, 600,000 rounds, a new random salt for each file).

To get the code back (needs git and Node 18 or newer), in a fresh clone:

```sh
git clone -b claude/wonderful-pascal-q89slw https://github.com/p10603797-ship-it/jojo-relay phortnite-code
cd phortnite-code
read -rs PHORTNITE_ADMIN && export PHORTNITE_ADMIN    # type the admin password, then Enter
node vault/open.mjs vault/history.vault
node vault/open.mjs vault/source.vault
unset PHORTNITE_ADMIN
```

The password works with or without its dashes. Then `git checkout work` gives the version on the
website, and `git checkout i27` the next one. The branch `autosave` is the newest save of
everything: its first parent is `work`, and each of its other parents holds the latest files of
one work folder, named in that commit's message.
