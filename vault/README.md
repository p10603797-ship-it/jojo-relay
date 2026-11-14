# Phortnite's locked save

`source.vault` holds the newest Phortnite code: the commits after
`dc2a163` (Phortnite 2.5.1), encrypted with AES-256-GCM under a key made
from the **admin password** (PBKDF2-SHA256, 600,000 rounds). Without that
password the file is unreadable.

To get the code back in a clone of this repository:

```sh
cd phortnite
npm ci
PHORTNITE_ADMIN=<admin password> node tools/vault.mjs open --in ../vault/source.vault --ref work
git checkout work
```
