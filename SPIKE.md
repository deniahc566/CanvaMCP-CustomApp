# Editing bridge spike

> **Done (2026-10-26).** The spike passed, and the bridge is now built into canva-mcp itself. See "Editing inside designs" and setup step 6 in the [README](README.md). The `bridge-spike` command described below has been removed; `npm run try-bridge` is its replacement. This file records how the question was answered.

The Connect REST API can't edit elements inside a design. Canva apps can: the Apps SDK's [Design Editing API](https://canva.dev/docs/apps/design-editing) reads and changes text, shapes and images on the open page. The plan is a small Canva app (`bridge-app/`) that runs in the editor and connects back to canva-mcp, much like figma-local's bridge plugin.

The one unknown is whether the Canva editor lets an app connect to `localhost` at all. Canva's [content security policy](https://canva.dev/docs/apps/content-security-policy) lists only `https:`/`wss:` for connections, and browsers restrict public pages from reaching local addresses. This spike answers that question before any real tools are built.

## What runs

| Piece | Command | What it does |
| --- | --- | --- |
| Spike server | `npm run bridge-spike -- --write` (in this folder) | Listens on `http/ws://localhost:3860` and `https/wss://localhost:3861` (self-signed localhost certificate in `~/.canva-mcp/certs`). Accepts WebSocket connections only from Canva app origins. When the app connects, it pings it, reads the current page, and with `--write` inserts and edits one test text element. Prints a verdict and saves `bridge-spike-result.json`. |
| Bridge app | `npm start` (in `bridge-app/`) | Builds the app and serves its bundle at `http://localhost:8080`, the way Canva's own dev server does. In the editor, it tries every route to canva-mcp (`fetch` and WebSocket, plain and TLS, `localhost` and `127.0.0.1`), shows which ones worked, then opens the bridge over the first working WebSocket. |

## Run it

1. **Build** (once):

   ```bash
   npm install
   ```

   ```bash
   npm run build
   ```

   ```bash
   cd bridge-app && npm install
   ```

2. **Set up the app in the Developer Portal.** Go to [Your apps](https://www.canva.com/developers/apps) and open your app, or click **Create an app** and choose **Public** (Private needs Enterprise). You can use the same app as the REST API integration. The app's left sidebar has an **Inside Canva** group:
   - **Intents:** under **Available intents**, click **Set up** next to **Design Editor**. Some Canva docs call this page **Configuration** or **Compatibility**.
   - **Code upload:** set **App source → Development URL** to `http://localhost:8080`.
   - **Permissions:** turn on `canva:design:content:read` and `canva:design:content:write`. This page only appears after an intent is set up. These `canva:` permissions are separate from the **Scopes** under **Outside Canva**.

3. **Start both servers**, each in its own terminal:

   ```bash
   npm run bridge-spike -- --write
   ```

   ```bash
   cd bridge-app && npm start
   ```

   `--write` adds a text element to the page that's open. Use a **new blank design** (any size except Docs and whiteboards), or leave `--write` off to only test reading.

4. **Open the app.** In the Developer Portal click **Preview**. The editor opens with the app; click **Open** the first time. Use Chrome or Edge.

5. **Read the panel.** It lists each route with ✓ or ✗:
   - **A `ws://` row has ✓:** the bridge connects right away and the terminal prints `PASS`.
   - **Only the `https`/`wss` rows fail:** click **Accept local certificate**, choose **Advanced → Proceed to localhost** on the page that opens, return to Canva and click **Retry**. This is a self-signed certificate, so the browser warns once per browser session.
   - **The browser asks to let Canva access apps and services on this device:** click **Allow**, then **Retry**.
   - **Everything fails:** the panel names the reason, for example "blocked by Content Security Policy (connect-src)". Copy or screenshot it.

6. **Undo the test edit.** With `--write`, a line "canva-mcp bridge edited HH:MM" appears at the top left of the page. Delete it, or press Ctrl+Z twice.

When it's done, the result is in `bridge-spike-result.json`. It records which routes worked, any CSP violations, ping times, the page read, and the write test.

## Optional: a trusted certificate instead of clicking through

If you'd rather not accept the browser warning each session, create a locally trusted certificate with [mkcert](https://github.com/FiloSottile/mkcert). Its `mkcert -install` step adds a local certificate authority to your system's trust store. Then point the spike at the files:

```bash
mkcert localhost 127.0.0.1 ::1
```

Set `CANVA_BRIDGE_CERT` and `CANVA_BRIDGE_KEY` to the two files it writes, then restart the spike.

## Result (2026-10-26, Edge 156 on Windows, dev-mode app)

**Pass.** The editor reached canva-mcp over plain `ws://localhost:3860` (and `http://` fetch) with no CSP violations, so development mode is looser than the published policy. `wss://` failed only because the self-signed certificate hadn't been accepted. Ping averaged 3 ms, reading the page took 8 ms, and inserting a text element, reading it back and replacing its text took 130 ms in total. The app's origin was `https://app-aahogil51rk.canva-apps.com`; it's stable per app, so the real bridge can accept that origin only.

Not yet covered: images, shapes, groups, locked elements, other pages (`all_pages`), and Docs or whiteboards.

**Follow-up, same day, with the app bundle uploaded to the Developer Portal instead of the Development URL:**
- The panel loads with nothing running on localhost.
- `ws://` is blocked by Canva's `connect-src` policy, as published.
- `wss://localhost:3861` connects once the browser has accepted the self-signed certificate; `read-page` took 15 ms.

The bridge now listens on both ports by default.

## What the result decides

- **`ws://` works:** the bridge can use plain WebSockets in development, with no certificate.
- **Only `wss://` works:** the bridge ships with a localhost certificate (self-signed, or mkcert).
- **Nothing works:** a local bridge isn't possible from the editor. The fallback is the official Canva connector's editing tools.
- **Connects but `read_page`/`write_test` fail:** the transport is fine, but editing doesn't work for this design. The error says why, for example a Docs page, a locked page or a missing permission.
