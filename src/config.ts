import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { BRIDGE_PORTS } from './bridge/protocol.js';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  /** OAuth client of your Canva integration (Developer Portal > Outside Canva > Configuration > Credentials). */
  clientId?: string;
  clientSecret?: string;
  /** Loopback URL Canva redirects to after sign-in. Must match the integration's redirect URL exactly. */
  redirectUri: string;
  /** Scopes requested at sign-in. Each must also be enabled on the integration. */
  scopes: string[];
  /** Where the access/refresh token pair is persisted. Refresh tokens are single use, so this file is rewritten on every refresh. */
  tokenFile: string;
  apiBase: string;
  /** Base of the sign-in page (https://www.canva.com). Overridable for tests. */
  authBase: string;
  /**
   * Prepended to every tool name so this server's tools never collide with the official Canva MCP
   * loaded in the same client. Empty string restores the official names.
   */
  toolPrefix: string;
  /** Where export-design saves files when asked to download them. */
  downloadDir: string;
  /** How long tools wait for an async Canva job (export, import, autofill...) before handing back the job ID. */
  jobTimeoutMs: number;
  bridge: BridgeConfig;
}

/** The local bridge the canva-mcp bridge app in the Canva editor connects to, for element-level editing. */
export interface BridgeConfig {
  enabled: boolean;
  port: number;
  /**
   * wss:// listener (self-signed or CANVA_BRIDGE_CERT/KEY). Apps loaded from the Development URL can
   * use plain ws://; an uploaded app bundle can only reach wss://.
   */
  tlsPort?: number;
  /** Serves bridge-app/dist/app.js here, the Development URL in the Developer Portal. 0 = don't serve. */
  appPort: number;
  appBundle: string;
  /** The app iframe's exact origin; only it may connect. Unset accepts any https://app-*.canva-apps.com. */
  appOrigin?: string;
  secretFile: string;
  certDir: string;
  certFile?: string;
  keyFile?: string;
  timeoutMs: number;
}

export const DEFAULT_TOOL_PREFIX = 'canva_local_';
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:3001/oauth/redirect';

/** Everything the tools use. brandtemplate:content:write (publish-brand-template) is opt-in via CANVA_SCOPES. */
export const DEFAULT_SCOPES = [
  'design:meta:read',
  'design:content:read',
  'design:content:write',
  'folder:read',
  'folder:write',
  'asset:read',
  'asset:write',
  'comment:read',
  'comment:write',
  'brandtemplate:meta:read',
  'brandtemplate:content:read',
  'profile:read',
];

function parsePrefix(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_TOOL_PREFIX;
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) throw new Error(`CANVA_TOOL_PREFIX may only contain letters, digits, "_" and "-" (got "${raw}").`);
  return raw;
}

function parseRedirect(raw: string | undefined): string {
  const value = raw || DEFAULT_REDIRECT_URI;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CANVA_REDIRECT_URI is not a valid URL (got "${value}").`);
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port) {
    throw new Error(`CANVA_REDIRECT_URI must be a loopback http URL with a port, like ${DEFAULT_REDIRECT_URI} (got "${value}").`);
  }
  return value;
}

function parseOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`CANVA_BRIDGE_APP_ORIGIN is not a valid URL (got "${raw}").`);
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.canva-apps.com')) {
    throw new Error(`CANVA_BRIDGE_APP_ORIGIN must look like https://app-xxxxxxxx.canva-apps.com (got "${raw}").`);
  }
  return url.origin;
}

function port(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number (got "${raw}").`);
  return n;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Read `.env` from the project root without overriding variables that are already set,
 * so `claude mcp add -e KEY=value` always wins over the file.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env, file = path.join(PROJECT_ROOT, '.env')): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parseEnv(raw))) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    clientId: env.CANVA_CLIENT_ID || undefined,
    clientSecret: env.CANVA_CLIENT_SECRET || undefined,
    redirectUri: parseRedirect(env.CANVA_REDIRECT_URI),
    scopes: env.CANVA_SCOPES ? env.CANVA_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
    tokenFile: expandHome(env.CANVA_TOKEN_FILE || path.join(os.homedir(), '.canva-mcp', 'tokens.json')),
    apiBase: (env.CANVA_API_BASE || 'https://api.canva.com/rest').replace(/\/+$/, ''),
    authBase: (env.CANVA_AUTH_BASE || 'https://www.canva.com').replace(/\/+$/, ''),
    toolPrefix: parsePrefix(env.CANVA_TOOL_PREFIX),
    downloadDir: expandHome(env.CANVA_DOWNLOAD_DIR || path.join(os.tmpdir(), 'canva-mcp-exports')),
    jobTimeoutMs: Number(env.CANVA_JOB_TIMEOUT_MS) || 90_000,
    bridge: {
      enabled: env.CANVA_BRIDGE !== 'off',
      port: port(env.CANVA_BRIDGE_PORT, BRIDGE_PORTS.ws, 'CANVA_BRIDGE_PORT'),
      // On by default: an app bundle uploaded to the Developer Portal may only use wss://. 0 turns it off.
      tlsPort: port(env.CANVA_BRIDGE_TLS_PORT, BRIDGE_PORTS.wss, 'CANVA_BRIDGE_TLS_PORT') || undefined,
      appPort: port(env.CANVA_BRIDGE_APP_PORT, BRIDGE_PORTS.app, 'CANVA_BRIDGE_APP_PORT'),
      appBundle: env.CANVA_BRIDGE_APP_BUNDLE || path.join(PROJECT_ROOT, 'bridge-app', 'dist', 'app.js'),
      appOrigin: parseOrigin(env.CANVA_BRIDGE_APP_ORIGIN),
      secretFile: expandHome(env.CANVA_BRIDGE_SECRET_FILE || path.join(os.homedir(), '.canva-mcp', 'bridge-secret')),
      certDir: expandHome(env.CANVA_BRIDGE_CERT_DIR || path.join(os.homedir(), '.canva-mcp', 'certs')),
      certFile: env.CANVA_BRIDGE_CERT || undefined,
      keyFile: env.CANVA_BRIDGE_KEY || undefined,
      timeoutMs: Number(env.CANVA_BRIDGE_TIMEOUT_MS) || 30_000,
    },
  };
}
