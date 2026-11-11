#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeHost } from './bridge/host.js';
import { TokenManager, TokenStore, openBrowser } from './canva/auth.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createServer } from './server.js';
import { errorMessage } from './util.js';

// stdout carries the MCP protocol, so all diagnostics go to stderr.
const log = (msg: string) => process.stderr.write(`[canva-mcp] ${msg}\n`);

/** `canva-mcp login|logout|status`: account setup from a terminal, outside any MCP client. */
async function cli(command: string): Promise<number> {
  const config = loadConfig();
  const auth = new TokenManager(config, new TokenStore(config.tokenFile));
  const out = (msg: string) => process.stdout.write(`${msg}\n`);

  if (command === 'status') {
    out(JSON.stringify(await auth.status(), null, 2));
    return 0;
  }
  if (command === 'logout') {
    const { revoked } = await auth.logout();
    out(revoked ? 'Signed out; the refresh token was revoked with Canva.' : `Signed out; deleted ${config.tokenFile}.`);
    return 0;
  }
  if (command === 'login') {
    const pending = await auth.startLogin();
    out('Opening the Canva sign-in page. If the browser does not open, visit:\n');
    out(`  ${pending.url}\n`);
    out(`Waiting for the redirect to ${config.redirectUri} (5 minutes)...`);
    if (process.env.CANVA_NO_BROWSER !== '1') openBrowser(pending.url);
    const tokens = await pending.done;
    out(`\nSigned in. Tokens saved to ${config.tokenFile}`);
    out(`Granted scopes: ${tokens.scope ?? '(not reported)'}`);
    return 0;
  }
  out('Usage: canva-mcp [login | logout | status]\nWith no command, runs the MCP server on stdio.');
  return command === 'help' || command === '--help' ? 0 : 1;
}

async function serve() {
  const config = loadConfig();
  if (!config.clientId || !config.clientSecret) {
    log('warning: CANVA_CLIENT_ID / CANVA_CLIENT_SECRET are not set; tools will fail until they are configured.');
  }
  let bridge: BridgeHost | undefined;
  if (config.bridge.enabled) {
    bridge = new BridgeHost({ ...config.bridge, log });
    // Owner or relay, it logs its own state; a failure here only affects the editing tools.
    await bridge.start().catch((err) => log(`bridge unavailable: ${errorMessage(err)}`));
  }
  const server = createServer(config, bridge);
  await server.connect(new StdioServerTransport());

  // stdin closing, SIGTERM and server.close() itself can each trigger this, so only the first call
  // does the work. On Windows, process.exit() while stdin's pipe is still closing trips a libuv
  // assertion, so let the process exit on its own and only force it if a handle lingers.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await bridge?.stop();
    await server.close();
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

async function main() {
  loadDotEnv();
  const command = process.argv[2];
  if (command) process.exitCode = await cli(command);
  else await serve();
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error && err.name !== 'AuthError' ? err.stack : errorMessage(err)}`);
  process.exit(1);
});
