import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Config } from '../config.js';
import { sleep } from '../util.js';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch ms after which access_token is no longer accepted. */
  expires_at: number;
  scope?: string;
  /** The integration that issued these tokens; a different CANVA_CLIENT_ID cannot refresh them. */
  client_id?: string;
  obtained_at: number;
}

export class AuthError extends Error {
  override name = 'AuthError';
}

/** Refresh this long before Canva's stated expiry so a request never goes out with a token about to lapse. */
const REFRESH_MARGIN_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

const NOT_LOGGED_IN = 'Not signed in to Canva. Call the login tool, or run `npm run login` in the canva-mcp folder, then retry.';

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

export class TokenStore {
  constructor(readonly file: string) {}

  async read(): Promise<StoredTokens | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return undefined;
      throw err;
    }
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      throw new AuthError(`The token file ${this.file} is not valid JSON. Delete it and sign in again.`);
    }
  }

  /** Write via a temp file and rename, so a crash mid-write never leaves a half-written (and unrecoverable) refresh token. */
  async write(tokens: StoredTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    // Windows refuses the rename while another process has the file open for reading; that clears in milliseconds.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, this.file);
        return;
      } catch (err) {
        if (attempt >= 10 || !(isErrno(err, 'EPERM') || isErrno(err, 'EBUSY') || isErrno(err, 'EACCES'))) {
          await fs.rm(tmp, { force: true });
          throw err;
        }
        await sleep(50);
      }
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }

  /**
   * Cross-process lock around the token file. Canva refresh tokens are single use, so two server
   * instances (one per Claude session) refreshing at once would leave one of them signed out.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const start = Date.now();
    for (;;) {
      try {
        const handle = await fs.open(lock, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (err) {
        if (!isErrno(err, 'EEXIST')) throw err;
        const stat = await fs.stat(lock).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { force: true });
          continue;
        }
        if (Date.now() - start > LOCK_WAIT_MS) {
          throw new AuthError(`Timed out waiting for the token lock ${lock}. If no other canva-mcp process is running, delete that file.`);
        }
        await sleep(100);
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lock, { force: true });
    }
  }
}

export interface PendingLogin {
  url: string;
  done: Promise<StoredTokens>;
}

export interface AuthStatus {
  clientConfigured: boolean;
  signedIn: boolean;
  tokenFile: string;
  accessTokenExpiresAt?: string;
  scope?: string;
  problem?: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export class TokenManager {
  private cached?: StoredTokens;
  private refreshing?: Promise<string>;
  private pending?: PendingLogin;

  constructor(
    private config: Config,
    readonly store: TokenStore,
  ) {}

  get clientConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private client(): { clientId: string; clientSecret: string } {
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret) {
      throw new AuthError('CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are not set. Add them to the MCP server environment or to canva-mcp/.env (see README, "Create a Canva integration").');
    }
    return { clientId, clientSecret };
  }

  async status(): Promise<AuthStatus> {
    const base = { clientConfigured: this.clientConfigured, tokenFile: this.store.file };
    let tokens: StoredTokens | undefined;
    try {
      tokens = await this.store.read();
    } catch (err) {
      return { ...base, signedIn: false, problem: (err as Error).message };
    }
    if (!tokens) return { ...base, signedIn: false, problem: NOT_LOGGED_IN };
    const problem =
      tokens.client_id && this.config.clientId && tokens.client_id !== this.config.clientId
        ? 'The saved tokens were issued to a different CANVA_CLIENT_ID. Sign in again.'
        : undefined;
    return { ...base, signedIn: !problem, accessTokenExpiresAt: new Date(tokens.expires_at).toISOString(), scope: tokens.scope, problem };
  }

  /** A usable access token, refreshed first when it expires within a minute. */
  async getAccessToken(): Promise<string> {
    const tokens = this.cached ?? (this.cached = await this.store.read());
    if (!tokens) throw new AuthError(NOT_LOGGED_IN);
    if (tokens.expires_at - REFRESH_MARGIN_MS > Date.now()) return tokens.access_token;
    return this.refresh(tokens.access_token);
  }

  /**
   * Swap the refresh token for a new pair. `stale` is the access token that expired or was rejected:
   * if the file already holds a different, still-valid one, another process refreshed first and that one is used.
   */
  refresh(stale?: string): Promise<string> {
    this.refreshing ??= this.doRefresh(stale).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(stale?: string): Promise<string> {
    this.client();
    return this.store.withLock(async () => {
      const current = await this.store.read();
      if (!current) throw new AuthError(NOT_LOGGED_IN);
      if (current.access_token !== stale && current.expires_at - REFRESH_MARGIN_MS > Date.now()) {
        this.cached = current;
        return current.access_token;
      }
      let next: StoredTokens;
      try {
        next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh_token });
      } catch (err) {
        throw new AuthError(`${(err as Error).message} The Canva session can't be renewed; call the login tool to sign in again.`);
      }
      await this.store.write(next);
      this.cached = next;
      return next.access_token;
    });
  }

  private async tokenRequest(params: Record<string, string>): Promise<StoredTokens> {
    const { clientId, clientSecret } = this.client();
    const res = await fetch(`${this.config.apiBase}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string') {
      const code = body.error ?? body.code ?? res.status;
      const detail = body.error_description ?? body.message ?? res.statusText;
      throw new AuthError(`Canva token request failed (${code}): ${detail}.`);
    }
    const now = Date.now();
    return {
      access_token: body.access_token,
      refresh_token: String(body.refresh_token),
      expires_at: now + Number(body.expires_in ?? 14_400) * 1000,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
      client_id: clientId,
      obtained_at: now,
    };
  }

  /**
   * Start the OAuth authorization-code + PKCE flow: listen on the loopback redirect URL and return
   * the Canva sign-in URL. `done` settles once the browser comes back and the code is exchanged.
   * A second call while one is pending returns the same sign-in.
   */
  async startLogin(timeoutMs = LOGIN_TIMEOUT_MS): Promise<PendingLogin> {
    if (this.pending) return this.pending;
    const { clientId } = this.client();
    const redirect = new URL(this.config.redirectUri);
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));

    const authorize = new URL(`${this.config.authBase}/api/oauth/authorize`);
    authorize.search = new URLSearchParams({
      code_challenge: challenge,
      code_challenge_method: 's256',
      scope: this.config.scopes.join(' '),
      response_type: 'code',
      client_id: clientId,
      state,
      redirect_uri: this.config.redirectUri,
    }).toString();

    let settle!: { resolve: (t: StoredTokens) => void; reject: (e: Error) => void };
    const done = new Promise<StoredTokens>((resolve, reject) => (settle = { resolve, reject }));
    let finished = false;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', this.config.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      if (finished) {
        page(res, 200, 'Already handled', 'This sign-in has already been completed. You can close this tab.');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        page(res, 400, 'Sign-in not recognised', 'This response does not belong to the current sign-in. Start the login again.');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        const detail = url.searchParams.get('error_description') ?? error ?? 'no authorization code was returned';
        page(res, 400, 'Canva sign-in failed', detail);
        finish(new AuthError(`Canva sign-in was not completed: ${detail}`));
        return;
      }
      try {
        const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.config.redirectUri });
        await this.store.withLock(() => this.store.write(tokens));
        this.cached = tokens;
        page(res, 200, 'Canva is connected', 'canva-mcp can now use your Canva account. You can close this tab.');
        finish(undefined, tokens);
      } catch (err) {
        page(res, 500, 'Canva sign-in failed', (err as Error).message);
        finish(err as Error);
      }
    });

    // Both the timer and the listener stay referenced: a pending sign-in is what keeps `canva-mcp login`
    // running until the browser comes back. finish() releases both.
    const timer = setTimeout(() => finish(new AuthError('Timed out waiting for the Canva sign-in to finish. Start the login again.')), timeoutMs);

    const finish = (err?: Error, tokens?: StoredTokens) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.pending = undefined;
      server.close();
      server.closeAllConnections?.();
      if (err) settle.reject(err);
      else settle.resolve(tokens!);
    };

    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          err.code === 'EADDRINUSE'
            ? new AuthError(`Port ${redirect.port} is already in use, so the sign-in callback can't be received. Close whatever is using it, or change CANVA_REDIRECT_URI (and the redirect URL in the Developer Portal).`)
            : err,
        );
      });
      server.listen(Number(redirect.port), redirect.hostname.replace(/^\[|\]$/g, ''), () => resolve());
    });

    // Nobody may be awaiting `done` (the login tool returns early); never let it become an unhandled rejection.
    done.catch(() => {});
    this.pending = { url: authorize.toString(), done };
    return this.pending;
  }

  /** Revoke the refresh token (and with it every access token from it), then forget both. */
  async logout(): Promise<{ revoked: boolean }> {
    const tokens = await this.store.read().catch(() => undefined);
    let revoked = false;
    if (tokens && this.clientConfigured) {
      const { clientId, clientSecret } = this.client();
      const res = await fetch(`${this.config.apiBase}/v1/oauth/revoke`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: tokens.refresh_token }),
      }).catch(() => undefined);
      revoked = Boolean(res?.ok);
    }
    await this.store.clear();
    this.cached = undefined;
    return { revoked };
  }
}

function page(res: http.ServerResponse, status: number, title: string, message: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
      `<h1 style="font-size:1.4rem">${esc(title)}</h1><p>${esc(message)}</p></body>`,
  );
}

/** Open a URL in the default browser. Best effort: the caller always shows the URL too. */
export function openBrowser(url: string): void {
  // rundll32 takes the URL as one argument; `cmd /c start` would split it at every "&".
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed or returned to the user, so a missing opener is not fatal.
  }
}
