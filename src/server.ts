import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeHost } from './bridge/host.js';
import { TokenManager, TokenStore } from './canva/auth.js';
import { CanvaRestClient } from './canva/rest.js';
import type { Config } from './config.js';
import { registerAccountTools } from './tools/account.js';
import { registerAssetTools } from './tools/assets.js';
import { registerBrandTools } from './tools/brand.js';
import { registerCommentTools } from './tools/comments.js';
import { toolName, type ToolBase, type ToolDeps } from './tools/common.js';
import { registerDesignTools } from './tools/designs.js';
import { registerEditorTools } from './tools/editor.js';
import { registerFolderTools } from './tools/folders.js';

export const SERVER_NAME = 'canva-mcp';
export const SERVER_VERSION = '0.1.0';

function instructions(prefix: string): string {
  const n = (base: ToolBase) => toolName(prefix, base);
  const naming = prefix
    ? `\nEvery tool here is named "${prefix}<official name>" (e.g. ${n('search-designs')}) so it never collides with the official Canva MCP connected at the same time. Prompts written for the official tools apply: call the ${prefix}-prefixed equivalent.\n`
    : '';
  return `A self-hosted Canva MCP server backed by the Canva Connect REST API and the user's own Canva integration.
Use it whenever the user mentions Canva, shares a canva.com or canva.link URL, or wants to find, create, fill, resize, export or comment on a design.
${naming}
SIGN-IN: if a tool says the server is not signed in, call ${n('login')}; the user approves access in their browser. ${n('whoami')} shows the account, granted scopes and plan capabilities.

FIND: ${n('search-designs')}, ${n('list-folder-items')} (folderId "root" = Projects), ${n('get-design')}, ${n('get-design-pages')}, ${n('get-design-thumbnail')} (see a design).
CREATE: ${n('create-design')} (blank), ${n('generate-design')} (AI doc/presentation from a brief), ${n('copy-design')}, ${n('import-design-from-url')} / ${n('import-design-from-file')} (PDF, PPTX, DOCX...), ${n('resize-design')}, ${n('merge-designs')}.
TEMPLATES: ${n('search-brand-templates')} -> ${n('get-brand-template-dataset')} -> ${n('autofill-design')}.
ASSETS: ${n('upload-asset-from-file')}, ${n('upload-asset-from-url')}, ${n('generate-image')}, ${n('remove-background')}.
OUTPUT: ${n('get-export-formats')}, ${n('export-design')} (set download: true to save files locally).
EDIT INSIDE A DESIGN (needs the design open in Chrome/Edge with the "canva-mcp bridge" app open): ${n('editor-status')} -> ${n('read-page')} -> ${n('edit-page')}.
  Change text, formatting, colors, position, rotation, background, order; insert text, rectangles, shapes; delete; group. Existing elements can't be resized (Canva API limit).
  Batches are all-or-nothing and undoable in the editor.
COLLABORATE: ${n('comment-on-design')}, ${n('reply-to-comment')}, ${n('get-comment-thread')}, ${n('list-replies')}.

IDS: design links look like https://www.canva.com/design/<designId>/<token>/edit; tools accept the link or the bare ID. Expand canva.link short links with ${n('resolve-shortlink')}.
Long jobs (exports, imports, autofill, generation) are awaited for you; if one is still running the tool returns a jobId, so continue with ${n('get-job')}.
edit_url/view_url links are temporary and only work for the signed-in user; share them with that user, not with others.
Plan limits: autofill, brand templates, resize, background removal and AI generation need paid Canva plans or capabilities; ${n('whoami')} lists what the account has.`;
}

export function createServer(config: Config, bridge?: BridgeHost): McpServer {
  const auth = new TokenManager(config, new TokenStore(config.tokenFile));
  const deps: ToolDeps = { config, auth, rest: new CanvaRestClient(config, auth), bridge };
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: instructions(config.toolPrefix) });
  registerAccountTools(server, deps);
  registerDesignTools(server, deps);
  registerAssetTools(server, deps);
  registerFolderTools(server, deps);
  registerCommentTools(server, deps);
  registerBrandTools(server, deps);
  registerEditorTools(server, deps);
  return server;
}
