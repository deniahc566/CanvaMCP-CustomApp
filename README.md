# canva-mcp

> 🇻🇳 **Hướng dẫn sử dụng tiếng Việt** (cách hoạt động, tính năng, giới hạn): [HUONG_DAN_SU_DUNG.md](HUONG_DAN_SU_DUNG.md)

A self-hosted MCP server for Canva that follows the tool names of the **official Canva MCP server**. It runs on your own machine against the [Canva Connect REST API](https://www.canva.dev/docs/connect/), using your own Canva integration and OAuth sign-in.

Each tool name starts with `canva_local_` (`canva_local_search-designs`, `canva_local_export-design`, …), so this server can run next to the official Canva connector without two tools sharing a name. To use the official names without the prefix, set `CANVA_TOOL_PREFIX` to an empty string.

```
MCP client (Claude Code, Claude Desktop, Cursor…)
        │ stdio
        ▼
   canva-mcp ──── HTTPS ────► api.canva.com/rest/v1/*         (Bearer access token)
        │
        ├── ~/.canva-mcp/tokens.json                          (access + refresh token, renewed automatically)
        ├── http://127.0.0.1:3001/oauth/redirect ◄── browser   (only while you sign in)
        │
        ├── http://localhost:8080 ──────► Canva editor           (serves the "canva-mcp bridge" app)
        └── ws://localhost:3860 / wss://localhost:3861 ◄── bridge app in the editor   (reads and edits the open page)
```

- **Sign-in** uses OAuth 2.0 authorization code + PKCE. Run `npm run login` once, or let the agent call `canva_local_login`. Both open the Canva consent page in your browser.
- **Tokens** are refreshed before they expire (access tokens last about 4 hours). Canva refresh tokens are **single use**, so the token file is rewritten on every refresh, under a cross-process lock. Several Claude sessions can run the server at once without signing each other out.
- **Long jobs** (exports, imports, uploads, autofill, resize, merge, AI generation) are polled for you. If one is still running after `CANVA_JOB_TIMEOUT_MS`, the tool returns a `jobId`, and `canva_local_get-job` picks it up from there.
- **Links:** design and folder parameters accept a pasted `canva.com/design/...` or `canva.com/folder/...` link as well as a bare ID. `canva.link` short links are expanded with `resolve-shortlink`.

## Tools

Names below are shown without the `canva_local_` prefix. "Official" marks tools that share a name with the official Canva MCP server.

| Tool | Official | Canva API | Notes |
| --- | --- | --- | --- |
| `whoami` | | users/me, profile, capabilities | Sign-in status, user/team IDs, display name, scopes, plan capabilities. |
| `login` | | OAuth | Opens the Canva consent page and waits for you to approve. |
| `resolve-shortlink` | ✓ | — | Follows `canva.link` redirects and returns the design ID. |
| `get-job` | | `GET /v1/*/{jobId}` | Continues any async job another tool returned as still running. |
| `search-designs` | ✓ | `GET /v1/designs` | Search or list, filter by ownership, sort, paginate. |
| `get-design` | ✓ | `GET /v1/designs/{id}` | Metadata, edit/view links, thumbnail URL. |
| `get-design-pages` | ✓ | `GET /v1/designs/{id}/pages` | Page numbers, dimensions, thumbnails. *Preview API.* |
| `get-design-thumbnail` | ✓ | design / pages | Returns the thumbnail **image** so the agent can see the design. |
| `get-export-formats` | ✓ | `GET /v1/designs/{id}/export-formats` | Which formats (and pages) a design can be exported to. |
| `create-design` | ✓ | `POST /v1/designs` | Blank design from a preset (doc, email, presentation, whiteboard) or custom size, optionally with an image asset. |
| `copy-design` | ✓ | `POST /v1/designs` | Copy of a design or some of its pages. *Preview API.* |
| `create-design-from-brand-template` | ✓ | `POST /v1/designs` | Copy of a brand template. *Preview API; plan with brand templates.* |
| `resize-design` | ✓ | `POST /v1/resizes` | Magic Resize to a preset or custom size. *Pro and above (trial on Free).* |
| `merge-designs` | ✓ | `POST /v1/merges` | New design from pages of others, or insert/move/delete pages in place. *Preview API.* |
| `generate-design` | ✓ | `POST /v1/generations` | AI Doc or presentation from a brief and an optional outline. *Preview API; needs `design_generation`, uses AI credits.* |
| `export-design` | ✓ | `POST /v1/exports` | pdf, jpg, png, pptx, gif, mp4, html_bundle, html_standalone, csv. `download: true` saves the files locally. |
| `import-design-from-url` | ✓ | `POST /v1/url-imports` | PDF, PPTX, DOCX, Keynote, AI, PSD… from a public URL into an editable design. |
| `import-design-from-file` | | `POST /v1/imports` | The same, from a file on this computer. |
| `upload-asset-from-url` | ✓ | `POST /v1/url-asset-uploads` | Image/video into Uploads; returns the asset ID. |
| `upload-asset-from-file` | | `POST /v1/asset-uploads` | The same, from a local file. |
| `get-assets` | ✓ | `GET /v1/assets/{id}` | Metadata for up to 20 assets. |
| `update-asset` | | `PATCH /v1/assets/{id}` | Rename or retag an asset. |
| `generate-image` | ✓ | `POST /v1/image-generations` | AI image from a prompt, shown inline, optionally saved to Uploads. *Preview API; needs `image_generation`.* |
| `remove-background` | ✓ | `POST /v1/image-transformations` | New asset with the background removed. *Preview API; paid plan.* |
| `create-folder` | ✓ | `POST /v1/folders` | In Projects (`root`), Uploads (`uploads`) or another folder. |
| `list-folder-items` | ✓ | `GET /v1/folders/{id}/items` | Folders, designs, images and brand templates. `root` = top of Projects. |
| `move-item-to-folder` | ✓ | `POST /v1/folders/move` | Move a design, folder or image. |
| `comment-on-design` | ✓ | `POST /v1/designs/{id}/comments` | New thread, with optional assignee. *Preview API.* |
| `reply-to-comment` | ✓ | `POST …/comments/{thread}/replies` | *Preview API.* |
| `get-comment-thread` | | `GET …/comments/{thread}` | *Preview API.* |
| `list-replies` | ✓ | `GET …/comments/{thread}/replies` | *Preview API.* |
| `search-brand-templates` | ✓ | `GET /v1/brand-templates` | `dataset: "non_empty"` returns only templates with autofill fields. *Plan with brand templates.* |
| `get-brand-template-dataset` | ✓ | `GET /v1/brand-templates/{id}/dataset` | The template's data fields and their types. |
| `get-design-dataset` | ✓ | `GET /v1/designs/{id}/dataset` | The same for a design. |
| `autofill-design` | ✓ | `POST /v1/autofills` | Fill text, image, video, chart or sheet fields: new design from a template or design, or update in place. *Pro, Teams or Enterprise.* |
| `publish-brand-template` | ✓ | `POST /v1/brand-templates` | Publish a design as a brand template. *Preview API; add the `brandtemplate:content:write` scope.* |
| `editor-status` | | bridge | Whether a Canva editor is connected, which design (with its ID) and page is open, and the page list. |
| `read-page` | | bridge | Elements of the open page (or page *n*): text and formatting, rectangles, shapes, groups, embeds, positions, colors. Each has a `path` and a `key`. |
| `edit-page` | | bridge | A batch of edits, all-or-nothing: set/replace/format text, move/rotate/fade, fill and outline colors, background, reorder, delete, group/ungroup, insert text/rectangles/shapes/images/embeds. `insert_image` uploads a local file or https URL to your Canva uploads and places it as its own element. `dryRun` previews. |

### Differences from the official server

The official server uses Canva internals that the public Connect API does not expose. These official tools are **not included**:

- **Editing transactions** (`start-editing-transaction`, `perform-editing-operations`, `commit-editing-transaction`, `cancel-editing-transaction`). The REST API can't edit elements inside a design. `read-page` and `edit-page` cover this through the editing bridge instead (see below); they need the design open in your browser.
- `get-design-content` and `get-presenter-notes`. There is no REST endpoint for a design's content; `read-page` reads the text of an open design.
- `create-design-from-candidate`. Public design generation creates the design directly, with no candidate step.
- `list-comments` (the API can't list threads; `get-comment-thread` reads one by ID), `search-folders`, `list-brand-kits`, `create-brand-template-draft`, `separate-image-layers`, `create-upload-url` and `help`.

### Editing inside designs: the bridge

Canva's REST API works on whole designs. To change what's *on* a page, canva-mcp uses a small Canva app, `bridge-app/`, built on the Apps SDK's [Design Editing API](https://canva.dev/docs/apps/design-editing). With a design open in Chrome or Edge and the app's panel open, the app connects to canva-mcp and carries out `read-page` and `edit-page`. The connection is `ws://localhost:3860` when the app loads from the Development URL, and `wss://localhost:3861` when it's uploaded to the Developer Portal. It works like the companion plugin of figma-local.

- **Only your app:** only your app's origin (`CANVA_BRIDGE_APP_ORIGIN`) may connect. Other websites, and other Canva apps, are refused.
- **All-or-nothing:** a batch is saved only after every operation succeeded. A failed batch leaves the design untouched, and every saved batch can be undone in the editor with Ctrl+Z.
- **Several Claude sessions:** the first canva-mcp instance owns the ports and the others relay through it. When it exits, the next one takes over, and the app panel reconnects by itself.
- **Limits of Canva's API:**
  - Existing elements can't be resized; change font size, or delete and re-insert.
  - Existing images can't be swapped, and a page background can't be set to an image. `insert_image` adds a new image as its own element.
  - Fonts can't be chosen: inserted and reformatted text uses Canva's default font.
  - Pages can't be added, moved or deleted through the bridge; use `merge-designs` on the same design.
  - Docs and whiteboards can't be edited.
  - Locked elements and pages are read-only.
- **No plan-based rate limit:** edits run in your browser. The [spike](SPIKE.md) measured about 3 ms per round trip and 130 ms for an insert-and-edit.

Tools marked *Preview API* use Canva endpoints that Canva may change without a new API version. Canva also doesn't allow public integrations that use preview APIs to pass review. That doesn't matter for your own account.

## Setup

### 1. Build

```bash
npm install
```

```bash
npm run build
```

Requires Node.js 22 or newer.

### 2. Create a Canva integration

1. Open the [Canva Developer Portal](https://www.canva.com/developers/) and create an app (choose **Public** unless your team is on Canva Enterprise and wants a private app). Canva reviews public apps only before *other* people can connect to them, so you don't need to submit it to use it with your own account.
2. Under **Outside Canva**, click **Start integrating**. This creates the OAuth client and opens **Configuration**.
3. Under **Integration methods**, turn on **Canva REST APIs**.
4. Under **Credentials**, copy the **Client ID**, then click **Generate secret** and copy the secret. Canva shows it only once.
5. Under **Scopes**, tick the scopes the tools use:

   | Scope | Used by |
   | --- | --- |
   | design:meta (Read) | search-designs, get-design, autofill job status |
   | design:content (Read + Write) | pages, thumbnails, exports, create/copy/resize/merge/generate, imports, autofill |
   | folder (Read + Write) | list-folder-items, create-folder, move-item-to-folder |
   | asset (Read + Write) | uploads, get-assets, update-asset, generate-image, remove-background |
   | comment (Read + Write) | comment tools |
   | brandtemplate:meta (Read), brandtemplate:content (Read) | brand template search and datasets |
   | profile (Read) | whoami (display name, capabilities) |
   | brandtemplate:content (Write), optional | publish-brand-template; also add it to `CANVA_SCOPES` |

6. Under **Redirect URLs**, set **URL 1** to `http://127.0.0.1:3001/oauth/redirect`. It must match `CANVA_REDIRECT_URI` exactly, including the port and path.

If you leave a scope unticked, also remove it from `CANVA_SCOPES`. Otherwise the sign-in asks for a scope the integration doesn't have.

### 3. Add your credentials

Copy `.env.example` to `.env` in this folder and fill in `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET`. The server reads `.env` from its own folder. Variables already set in the environment (for example with `claude mcp add -e`) take precedence.

### 4. Sign in

```bash
npm run login
```

Your browser opens Canva's consent page. Click **Allow**, and the terminal confirms the tokens were saved to `~/.canva-mcp/tokens.json`. Check the result at any time:

```bash
npm run status
```

You can also skip this step and ask the agent to "sign in to Canva". It calls `canva_local_login`, which runs the same flow.

### 5. Register the server with your client

Claude Code (user scope, so every project gets it):

```bash
claude mcp add canva-local -s user -- node D:/CanvaMCP/dist/index.js
```

Claude Desktop, Cursor and other JSON-configured clients:

```json
{
  "mcpServers": {
    "canva-local": {
      "command": "node",
      "args": ["D:/CanvaMCP/dist/index.js"]
    }
  }
}
```

The credentials come from `.env`. To keep them in the client config instead, add `"env": { "CANVA_CLIENT_ID": "…", "CANVA_CLIENT_SECRET": "…" }`, or use `-e` with `claude mcp add`.

### 6. Set up the editing bridge (optional)

1. In the [Developer Portal](https://www.canva.com/developers/apps), open the same app. Under **Inside Canva**:
   - **Intents:** click **Set up** next to **Design Editor**.
   - **Permissions:** turn on `canva:design:content:read` and `canva:design:content:write`, and `canva:asset:private:write` for `insert_image` (it uploads the image to your Canva uploads before placing it).
   - **Code upload → App source:** choose one of the two options in the next table.
2. Copy the app's origin into `.env` as `CANVA_BRIDGE_APP_ORIGIN`. It looks like `https://app-xxxxxxxx.canva-apps.com`. The bridge panel shows it as **App origin**; it's also under **Security** in the Developer Portal.
3. Open a design in Chrome or Edge. Then click **Preview** in the Developer Portal, or open **canva-mcp bridge** from the editor's Apps panel. The panel says **Connected** once canva-mcp is running; it starts with Claude, and the panel keeps retrying until it does.

| | Uploaded bundle (recommended) | Development URL |
| --- | --- | --- |
| Set up | Leave **Development URL** empty and upload `bridge-app/dist/app.js`. The Development URL takes priority while it has a value. | Set **Development URL** to `http://localhost:8080`. |
| Panel when Claude isn't running | Loads, and waits for canva-mcp. | Fails to load ("couldn't load the app's JavaScript bundle"); reload the panel after Claude starts. |
| Connection | `wss://localhost:3861` only. Canva's policy for uploaded apps blocks `ws://`. | `ws://localhost:3860`, no certificate. |
| Once per browser session | Accept the bridge's self-signed certificate: click **Open certificate page** in the panel, or open https://localhost:3861, then choose **Advanced → Continue**. | Allow local network access when Chrome or Edge asks. |
| After changing `bridge-app/` | Run `npm run build` and upload `app.js` again. | Reload the panel. |

To skip accepting the certificate each session, use a certificate your system trusts. Create one with [mkcert](https://github.com/FiloSottile/mkcert). Its `mkcert -install` step adds a local certificate authority to your trust store, which is your call to make. Then run:

```bash
mkcert localhost 127.0.0.1 ::1
```

Set `CANVA_BRIDGE_CERT` and `CANVA_BRIDGE_KEY` in `.env` to the two files it writes.

Check it any time with `npm run try-bridge`, which reads the open page without changing it. `npm run try-bridge -- --edit` also runs a set of test edits; only use that on a throwaway design.

## Rebuilding SVG slides in Canva

`scripts/svg2canva.mjs` turns SVG slides into native, editable Canva elements on pages of the design open in the editor. It was made for ppt-master's `svg_output` folders. It needs the editing bridge, and can run while Claude is using canva-mcp.

```bash
npm run svg2canva -- <svg folder> [mapping ...] [options]
```

Slides are the folder's `.svg` files in name order. Without a mapping, slide 1 goes on page 1, slide 2 on page 2, and so on. `3:7` puts slide 3 on page 7, and `2-5:10` puts slides 2–5 on pages 10–13. The pages must already exist, so add them in Canva first. Each slide is scaled to fit its page.

| Option | Effect |
| --- | --- |
| `--replace` | Clears target pages that already have content. Without it, the script refuses them before changing anything. |
| `--check` | Validates every batch with a dry run in Canva. Changes nothing. |
| `--dry` | Converts without Canva and lists what each slide becomes. |
| `--out <dir>` | Also saves each slide's operations as JSON. |
| `--font-scale`, `--ascent` | Text calibration. The defaults (0.94, 0.95) are measured for Segoe UI slides set in Canva's default font. |

- **Carried over:**
  - shapes: rectangles (rounded too), circles, ellipses, lines, polylines, polygons and paths;
  - text with its line breaks, colors, weights and letter spacing, and a size per line;
  - opacity, `translate()`, attributes inherited from groups;
  - linear gradients on rectangles, drawn as 30 bands of color.
- **Not carried over:** each of these prints a note.
  - images: left out; place them with `edit-page`'s `insert_image`, or by hand;
  - fonts: Canva's default font is used;
  - dashed outlines: drawn solid;
  - two text sizes on one line: drawn in one size;
  - radial gradients: drawn in their middle color;
  - other transforms, clip paths, masks and filters.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET` | — | Your integration's credentials. Required. |
| `CANVA_REDIRECT_URI` | `http://127.0.0.1:3001/oauth/redirect` | Loopback callback for sign-in. Must match the Developer Portal. Change the port if 3001 is taken. |
| `CANVA_SCOPES` | all read/write scopes the tools use | Space-separated list requested at sign-in. |
| `CANVA_TOKEN_FILE` | `~/.canva-mcp/tokens.json` | Where tokens are stored. |
| `CANVA_DOWNLOAD_DIR` | `<temp>/canva-mcp-exports` | Where `export-design` saves files when `download` is true. |
| `CANVA_JOB_TIMEOUT_MS` | `90000` | How long a tool waits for an async job before returning its `jobId`. |
| `CANVA_TOOL_PREFIX` | `canva_local_` | Tool name prefix; empty for the official names. |
| `CANVA_NO_BROWSER` | — | `1`: `npm run login` only prints the sign-in URL instead of opening a browser. |
| `CANVA_BRIDGE_APP_ORIGIN` | — (any `https://app-*.canva-apps.com`) | The bridge app's origin. Only it may connect; set it. |
| `CANVA_BRIDGE` | on | `off` disables the bridge and its three tools. |
| `CANVA_BRIDGE_APP_PORT` | `8080` | Where the app bundle is served; must match the Development URL. `0` = don't serve. |
| `CANVA_BRIDGE_TLS_PORT` | `3861` | The `wss://` listener an uploaded app bundle connects to. Uses a self-signed certificate in `~/.canva-mcp/certs`, or `CANVA_BRIDGE_CERT`/`CANVA_BRIDGE_KEY`. `0` turns it off. |
| `CANVA_BRIDGE_TIMEOUT_MS` | `30000` | How long to wait for the app to answer. |

Commands: `node dist/index.js login | logout | status`. `logout` revokes the refresh token with Canva and deletes the token file. With no command, the server runs MCP over stdio.

## Troubleshooting

- **"Not signed in to Canva"**: run `npm run login`, or ask the agent to sign in.
- **Sign-in page shows an error about the redirect URL or scopes**: the redirect URL in the Developer Portal must equal `CANVA_REDIRECT_URI`, and every scope in `CANVA_SCOPES` must be ticked on the integration.
- **"Port 3001 is already in use"**: stop whatever is using it, or pick another port in both `CANVA_REDIRECT_URI` and the Developer Portal.
- **403 permission_denied**: the integration lacks the scope that call needs, or you enabled it after signing in. Sign in again with `login` and `force: true`, or run `npm run login`. Plan-gated features (autofill, brand templates, resize, background removal, AI generation) also return 403 on plans without them; `whoami` lists your `capabilities`.
- **Export fails with `license_required`**: the design uses premium elements your account isn't licensed for.
- **"refresh token already used" / can't renew**: something else spent the refresh token (for example a copy of the token file on another machine). Sign in again.
- **"No Canva editor is connected"**: open the design in Chrome or Edge with the canva-mcp bridge panel open. If the panel shows "Waiting", allow local network access in the address bar, then click **Retry now**. The Canva desktop app can't load apps from `localhost`.
- **"An error occurred and we couldn't load the app's JavaScript bundle"** in the panel: the app is set to load from the Development URL and canva-mcp isn't running, or something else holds port 8080. Start Claude, or run `npm run try-bridge`, then reload the panel. Alternatively, switch to the uploaded bundle.
- **Panel lists `ws://` as "blocked by Content Security Policy" and `wss://` as "not reachable"**: this is the uploaded bundle. If Claude is running, the browser hasn't accepted the certificate yet: click **Open certificate page** and choose **Advanced → Continue**. `editor-status` also reports rejected certificate handshakes.
- **"The bridge app … is an older version"**: click the reload icon at the top of the app panel.
- **"Port 3860 is in use by a program that isn't a canva-mcp bridge"**: stop whatever holds the port. `editor-status` shows the message.
- **"changed since it was read"**: the element moved or its text changed after `read-page` (maybe you edited it). Read the page again and retry.

## Development

```bash
npm test
```

The tests build the server and run against local stand-ins:
- **REST and OAuth** (`test/mock-canva.mjs`): the PKCE login, refresh-token rotation (including two processes refreshing at once), 401 retry, job polling and `get-job` hand-off, uploads, exports with downloads, and tool naming.
- **The editor** (`test/fake-editor.mjs`): the bridge app's real handlers run against a fake editor. These tests cover every edit operation, all-or-nothing batches and stale keys, origin pinning, the bundle server, relaying between instances with takeover, and a port taken by another program.
- **svg2canva** (`test/svg2canva.test.mjs`): page mappings, slide order, and converting a sample slide (`test/svg-sample.mjs`), whose operations must also pass `edit-page` against the fake editor.

`npm run build` also builds the bridge app (`bridge-app/`, bundled with esbuild into `bridge-app/dist/app.js`). `npm install` installs its dependencies.
