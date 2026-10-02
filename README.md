# jojo-relay

A tiny, dependency-light Node service that does two unrelated jobs on one free web host:

1. **WebSocket relay** for *BENEDICT LASO VS JOJO THE DESTROYER* — rooms, six-digit
   join codes and byte forwarding. No game logic, no persistence.
2. **Sideload portal** (`/sideload/`) — a self-hosted, iPad-first web page for
   installing your **signed** iOS/iPadOS apps over the air, straight from Safari.

Both run from `node relay.js`. The only runtime dependency is [`ws`](https://www.npmjs.com/package/ws).

```bash
npm install
npm start           # listens on $PORT (default 8787)
npm run health      # prints /health JSON
```

---

## Sideload portal

Open **`https://<your-host>/sideload/`** on an iPad. From there you can:

- Add apps by pasting the **HTTPS URL of a signed `.ipa`** plus its bundle id,
  version, name and (optional) icon. Your library is stored only in that browser
  (`localStorage`) — nothing is uploaded to the server.
- Tap **Install** to install over the air, **Share** to send a prefilled install
  link to another device, or **Copy** the raw `itms-services://` link.
- **Add to Home Screen** (Safari share sheet) to use it full-screen like an app;
  it even opens offline (a small service worker caches the shell).

### How it works

The portal uses Apple's documented over-the-air install flow:

```
itms-services://?action=download-manifest&url=https://<host>/sideload/manifest.plist?ipa=…
```

The server generates the `manifest.plist` on the fly from the query string. It
**never downloads** the `.ipa` or icon — it only names them in the manifest that
iOS fetches — so the endpoint is a pure template renderer with no SSRF surface.
All interpolated values are XML-escaped, and the `.ipa`/icon URLs are required to
be `https://`.

### What you need for an install to actually succeed

This streamlines *distribution*. It does **not** sign apps and bypasses nothing —
iOS still refuses any `.ipa` that isn't properly signed for the target device:

- A **signed `.ipa`**, served over `https://` with a valid certificate:
  - **Ad-hoc** (Apple Developer, $99/yr): provisioning profile lists the device **UDID**.
  - **Enterprise** (Apple Developer Enterprise, $299/yr): in-house distribution.
  - **Your own dev builds**: usually installed via Xcode/AltStore for free accounts.
- The **manifest over HTTPS** — automatic when you open the portal from its hosted URL.
- Open install links in **Safari**, and trust the developer afterwards under
  **Settings → General → VPN & Device Management** if prompted.

> If an install says *"Unable to Install"*, the `.ipa` is almost always not signed
> for this device, not reachable over HTTPS, or has a wrong bundle id/version.
> That is Apple's security check — no website can get around it. Use the portal
> only for apps you are authorised to install.

### Endpoints

| Path | Purpose |
| --- | --- |
| `GET /sideload/` | the portal UI |
| `GET /sideload/app.webmanifest` | PWA manifest |
| `GET /sideload/sw.js` | offline-shell service worker |
| `GET /sideload/icon-180.png`, `icon-512.png` | home-screen icons |
| `GET /sideload/manifest.plist?ipa=…&bundle=…&version=…&title=…&icon=…` | generated OTA manifest |

---

## Relay

The relay forwards opaque gameplay bytes between the two peers of a room. See the
header of [`relay.js`](./relay.js) for the wire protocol. Health JSON lives at
`/health`; a status page is served at `/`.

### Configuration (environment variables)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | listen port (Render injects this) |
| `HOST` | `0.0.0.0` | bind address |
| `MAX_ROOMS` | `500` | room cap |
| `MAX_CONNS_PER_IP` | `16` | per-IP connection cap |
| `MAX_MESSAGE_BYTES` | `65536` | max frame size |
| `ORIGIN_ALLOWLIST` | *(any)* | comma-separated allowed `Origin`s (`*` wildcards ok) |
| `LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error`\|`silent` |

## Deploy (Render)

[`render.yaml`](./render.yaml) is a Render Blueprint: Node web service, `npm install
--omit=dev`, `node relay.js`, health check at `/health`. Render terminates TLS, so
both the relay (`wss://`) and the sideload portal (`https://`) are served securely —
which is exactly what iOS over-the-air installs require.

## License

MIT
