import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { BridgeCert } from './cert.js';
import { BRIDGE_PATH, BRIDGE_PROTOCOL_VERSION, RELAY_PATH, type AppMessage, type BridgeMethod, type CspViolation, type HelloMessage, type RequestMessage } from './protocol.js';

/** Messages on the relay socket between a second canva-mcp instance and the one that owns the ports. */
export type RelayRequest = { type: 'relay'; id: number } & ({ op: 'request'; method: BridgeMethod; params?: unknown; timeoutMs: number } | { op: 'status' });
export interface RelayResult {
  type: 'relay-result';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AppInfo {
  origin: string;
  url: string;
  protocol: number;
  connectedAt: string;
  lastUsedAt?: string;
  current: boolean;
  outdated: boolean;
  /** Content Security Policy violations the app saw before connecting, e.g. a blocked ws:// attempt. */
  cspViolations: CspViolation[];
}

export interface OwnerStatus {
  listening: string[];
  appBundle: { url?: string; served: boolean; problem?: string };
  originPinned: string | null;
  apps: AppInfo[];
  /** wss handshakes that failed, almost always a browser that hasn't accepted the self-signed certificate. */
  tlsRejected?: { count: number; last: string; at: string };
}

export interface BridgeServerOptions {
  port: number;
  /** Optional wss:// listener for when plain ws is blocked. Needs `cert`. */
  tlsPort?: number;
  cert?: BridgeCert;
  /** Serve the app bundle on this port (the Developer Portal's Development URL). 0 = don't. */
  appPort: number;
  appBundle: string;
  /** The app's exact origin, e.g. https://app-aabbccdd.canva-apps.com. Unset accepts any Canva app origin. */
  appOrigin?: string;
  /** Shared with other canva-mcp instances so they can relay through this one. */
  secret: string;
  log: (msg: string) => void;
  /** Only for tests: hosts to bind. */
  hosts?: string[];
}

const ANY_CANVA_APP = /^https:\/\/app-[a-z0-9]+\.canva-apps\.com$/i;

/** Whether a WebSocket Origin is the bridge app: the pinned origin exactly, or any Canva app iframe when not pinned. */
export function appOriginAllowed(origin: string | undefined, pinned?: string): boolean {
  if (!origin) return false;
  return pinned ? origin.toLowerCase() === pinned.toLowerCase() : ANY_CANVA_APP.test(origin);
}

export class AppConnection {
  hello?: HelloMessage;
  readonly connectedAt = new Date();
  lastUsedAt?: Date;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private ws: WebSocket,
    readonly origin: string,
  ) {}

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  request<T>(method: BridgeMethod, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    this.lastUsedAt = new Date();
    const message: RequestMessage = { type: 'request', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The Canva app did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s. Is the design still open in the browser tab?`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify(message));
    });
  }

  handleResponse(msg: Extract<AppMessage, { type: 'response' }>): void {
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error ?? 'The Canva app reported an error.'));
  }

  failAll(reason: string): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * The listening side of the bridge, run by whichever canva-mcp instance got the ports first:
 * accepts the Canva app on /bridge, other canva-mcp instances on /relay, and serves the app bundle.
 */
export class BridgeServer {
  readonly listening: string[] = [];
  private servers: http.Server[] = [];
  private appServers: http.Server[] = [];
  private appBundle: OwnerStatus['appBundle'] = { served: false };
  private wss = new WebSocketServer({ noServer: true });
  private apps = new Set<AppConnection>();
  private peers = new Set<WebSocket>();
  private tlsRejected?: OwnerStatus['tlsRejected'];

  constructor(private opts: BridgeServerOptions) {}

  /** Binds the bridge port; rejects with EADDRINUSE when another process has it. */
  async start(): Promise<void> {
    const hosts = this.opts.hosts ?? ['127.0.0.1', '::1'];
    const handler = (secure: boolean) => (req: http.IncomingMessage, res: http.ServerResponse) => this.handleHttp(secure, req, res);
    await this.listenAll(hosts, this.opts.port, 'http', () => http.createServer(handler(false)), this.servers, true);
    if (this.opts.tlsPort && this.opts.cert) {
      const { key, cert } = this.opts.cert;
      const tls = () => {
        const server = https.createServer({ key, cert }, handler(true));
        server.on('tlsClientError', (err) => {
          const first = !this.tlsRejected;
          this.tlsRejected = { count: (this.tlsRejected?.count ?? 0) + 1, last: err.message, at: new Date().toISOString() };
          if (first) this.opts.log(`a wss:// handshake failed (${err.message}); the browser probably hasn't accepted the certificate yet`);
        });
        return server;
      };
      await this.listenAll(hosts, this.opts.tlsPort, 'https', tls, this.servers, false).catch((err) => this.opts.log(`wss listener unavailable: ${(err as Error).message}`));
    }
    for (const server of this.servers) server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    if (this.opts.appPort) {
      const serveBundle = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handleBundle(req, res);
      try {
        await this.listenAll(hosts, this.opts.appPort, 'http', () => http.createServer(serveBundle), this.appServers, true, false);
        this.appBundle = { url: `http://localhost:${this.opts.appPort}`, served: true };
      } catch (err) {
        const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        this.appBundle = {
          served: false,
          problem: inUse
            ? `Port ${this.opts.appPort} is in use, so canva-mcp isn't serving the app bundle. That's fine if bridge-app's own dev server (npm start) is what's using it.`
            : `Couldn't serve the app bundle: ${(err as Error).message}`,
        };
      }
    } else {
      this.appBundle = { served: false, problem: 'Not served (CANVA_BRIDGE_APP_PORT=0); the app must be uploaded to the Developer Portal.' };
    }
  }

  /**
   * Listen on every host. The first host must succeed (its EADDRINUSE is how a second instance
   * learns it should relay); ::1 is skipped when IPv6 is off.
   */
  private async listenAll(
    hosts: string[],
    port: number,
    scheme: string,
    make: () => http.Server,
    into: http.Server[],
    required: boolean,
    record = true,
  ): Promise<void> {
    for (const [i, host] of hosts.entries()) {
      const server = make();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => resolve());
        });
        into.push(server);
        if (record) this.listening.push(`${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (i > 0 && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) continue;
        if (required) {
          await Promise.all(into.map((s) => new Promise((r) => s.close(r))));
          into.length = 0;
          throw err;
        }
        this.opts.log(`could not listen on ${scheme}://${host}:${port}: ${code ?? (err as Error).message}`);
      }
    }
  }

  async stop(): Promise<void> {
    for (const app of this.apps) app.close();
    for (const peer of this.peers) peer.close();
    await Promise.all(
      [...this.servers, ...this.appServers].map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections?.();
          }),
      ),
    );
  }

  /** The app the next request goes to: the most recent connection that speaks this protocol version. */
  private currentApp(): AppConnection | undefined {
    const ready = [...this.apps].filter((a) => a.open && a.hello && a.hello.protocol === BRIDGE_PROTOCOL_VERSION);
    return ready.sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime())[0];
  }

  async request<T>(method: BridgeMethod, params: unknown, timeoutMs: number): Promise<T> {
    const app = this.currentApp();
    if (!app) {
      const outdated = [...this.apps].some((a) => a.open && a.hello && a.hello.protocol !== BRIDGE_PROTOCOL_VERSION);
      throw new Error(
        outdated
          ? 'The canva-mcp bridge app open in Canva is an older version. Click the reload icon at the top of its panel.'
          : 'No Canva editor is connected. Open the design in Chrome or Edge and open the "canva-mcp bridge" app from the Apps panel (or click Preview in the Developer Portal).',
      );
    }
    return app.request<T>(method, params, timeoutMs);
  }

  status(): OwnerStatus {
    const current = this.currentApp();
    return {
      listening: this.listening,
      appBundle: this.appBundle,
      originPinned: this.opts.appOrigin ?? null,
      apps: [...this.apps]
        .filter((a) => a.open)
        .map((a) => ({
          origin: a.origin,
          url: a.hello?.url ?? '',
          protocol: a.hello?.protocol ?? 0,
          connectedAt: a.connectedAt.toISOString(),
          lastUsedAt: a.lastUsedAt?.toISOString(),
          current: a === current,
          outdated: (a.hello?.protocol ?? 0) !== BRIDGE_PROTOCOL_VERSION,
          cspViolations: a.hello?.cspViolations ?? [],
        })),
      tlsRejected: this.tlsRejected,
    };
  }

  private handleHttp(secure: boolean, req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      // On the wss port this is the page the user opens to accept the self-signed certificate.
      const state = this.currentApp() ? 'The Canva app is connected.' : 'Waiting for the Canva app.';
      const note = secure ? ' Your browser now accepts this local certificate: go back to Canva, and the bridge panel connects within a few seconds.' : '';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`canva-mcp bridge: ${state}${note}\n`);
      return;
    }
    res.writeHead(404).end();
  }

  private async handleBundle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const headers = {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers).end();
      return;
    }
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/' && pathname !== '/app.js') {
      res.writeHead(404).end();
      return;
    }
    try {
      res.writeHead(200, headers).end(await fs.readFile(this.opts.appBundle));
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end(`The bridge app isn't built. Run "npm run build" in the canva-mcp folder.\n`);
    }
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    const refuse = (why: string) => {
      this.opts.log(`refused ${pathname} connection: ${why}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };

    if (pathname === BRIDGE_PATH) {
      if (!appOriginAllowed(origin, this.opts.appOrigin)) {
        refuse(`origin ${origin ?? '(none)'} is not ${this.opts.appOrigin ?? 'a Canva app'}`);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptApp(ws, origin!));
      return;
    }
    if (pathname === RELAY_PATH) {
      // Browsers always send Origin and can't read the secret file, so this only admits local canva-mcp processes.
      if (origin !== undefined || req.headers['x-canva-bridge-secret'] !== this.opts.secret) {
        refuse('missing or wrong relay secret');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptPeer(ws));
      return;
    }
    socket.destroy();
  }

  private acceptApp(ws: WebSocket, origin: string): void {
    const app = new AppConnection(ws, origin);
    this.apps.add(app);
    ws.on('message', (data) => {
      let msg: AppMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'hello') app.hello = msg;
      else if (msg.type === 'response') app.handleResponse(msg);
    });
    ws.on('close', () => {
      this.apps.delete(app);
      app.failAll('The Canva app disconnected before answering. Was the tab closed or the app panel reloaded?');
    });
  }

  private acceptPeer(ws: WebSocket): void {
    this.peers.add(ws);
    ws.on('close', () => this.peers.delete(ws));
    ws.on('message', async (data) => {
      let msg: RelayRequest;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type !== 'relay') return;
      let reply: RelayResult;
      try {
        const result = msg.op === 'status' ? this.status() : await this.request(msg.method, msg.params, msg.timeoutMs);
        reply = { type: 'relay-result', id: msg.id, ok: true, result };
      } catch (err) {
        reply = { type: 'relay-result', id: msg.id, ok: false, error: (err as Error).message };
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    });
  }
}
