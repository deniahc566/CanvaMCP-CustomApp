import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ensureCert } from './cert.js';
import { RELAY_PATH, type BridgeMethod } from './protocol.js';
import { BridgeServer, type OwnerStatus, type RelayRequest, type RelayResult } from './server.js';

export interface BridgeHostOptions {
  port: number;
  tlsPort?: number;
  certDir: string;
  certFile?: string;
  keyFile?: string;
  appPort: number;
  appBundle: string;
  appOrigin?: string;
  secretFile: string;
  log: (msg: string) => void;
  hosts?: string[];
}

export type BridgeStatus =
  | ({ mode: 'owner' } & OwnerStatus)
  | ({ mode: 'relay'; via: string } & OwnerStatus)
  | { mode: 'unavailable'; problem: string };

/** Read the relay secret, creating it on first use. Every canva-mcp instance on this machine shares it. */
async function loadSecret(file: string): Promise<string> {
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // Created below.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, secret, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch {
    // Another instance created it at the same moment: use theirs.
    return (await fs.readFile(file, 'utf8')).trim();
  }
}

/** A connection to the instance that owns the ports, used when this instance couldn't get them. */
class RelayClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(
    private ws: WebSocket,
    readonly url: string,
  ) {
    ws.on('message', (data) => {
      let msg: RelayResult;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error));
    });
    ws.on('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('Lost the connection to the canva-mcp instance that owns the bridge.'));
      this.pending.clear();
    });
  }

  static connect(url: string, secret: string): Promise<RelayClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { 'x-canva-bridge-secret': secret } });
      ws.once('open', () => resolve(new RelayClient(ws, url)));
      ws.once('unexpected-response', (_req, res) => {
        ws.terminate();
        reject(new Error(res.statusCode === 403 ? 'refused the relay secret' : `answered HTTP ${res.statusCode}`));
      });
      ws.once('error', reject);
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  onClose(listener: () => void): void {
    this.ws.on('close', listener);
  }

  call<T>(msg: RelayRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The canva-mcp instance that owns the bridge did not answer.'));
      }, timeoutMs + 5000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * The bridge as the tools see it. Every Claude session runs its own canva-mcp, but only one can own
 * the ports the Canva app connects to: the first instance owns them, later ones relay through it,
 * and when the owner exits the next instance to notice takes over.
 */
export class BridgeHost {
  private server?: BridgeServer;
  private relay?: RelayClient;
  private secret?: string;
  private problem?: string;
  private settling?: Promise<void>;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;

  constructor(private opts: BridgeHostOptions) {}

  start(): Promise<void> {
    return this.settle();
  }

  /** Become the owner if the port is free, otherwise connect to the owner. Concurrent callers share one attempt. */
  private settle(): Promise<void> {
    this.settling ??= this.trySettle().finally(() => {
      this.settling = undefined;
    });
    return this.settling;
  }

  private async trySettle(): Promise<void> {
    if (this.stopped || this.server || this.relay?.open) return;
    this.secret ??= await loadSecret(this.opts.secretFile);
    const cert = this.opts.tlsPort ? await ensureCert(this.opts.certDir, { certFile: this.opts.certFile, keyFile: this.opts.keyFile }) : undefined;
    const server = new BridgeServer({ ...this.opts, cert, secret: this.secret });
    try {
      await server.start();
      this.server = server;
      this.problem = undefined;
      this.opts.log(`bridge listening on ${server.listening.join(', ')}`);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        this.problem = `The bridge couldn't listen on port ${this.opts.port}: ${(err as Error).message}`;
        return;
      }
    }
    const url = `ws://127.0.0.1:${this.opts.port}${RELAY_PATH}`;
    try {
      const relay = await RelayClient.connect(url, this.secret);
      this.relay = relay;
      this.problem = undefined;
      relay.onClose(() => {
        if (this.relay === relay) this.relay = undefined;
        // The owner went away: race the other instances for the ports after a short random delay.
        if (!this.stopped) this.scheduleRetry(200 + Math.random() * 800);
      });
    } catch (err) {
      this.problem =
        `Port ${this.opts.port} is in use by a program that isn't a canva-mcp bridge (${(err as Error).message}). ` +
        'If the old "npm run bridge-spike" is still running, stop it with Ctrl+C.';
      this.scheduleRetry(5000);
    }
  }

  private scheduleRetry(ms: number): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.settle(), ms);
    this.retryTimer.unref();
  }

  async request<T>(method: BridgeMethod, params: unknown, timeoutMs: number): Promise<T> {
    await this.settle();
    if (this.server) return this.server.request<T>(method, params, timeoutMs);
    if (this.relay) return this.relay.call<T>({ type: 'relay', op: 'request', method, params, timeoutMs }, timeoutMs);
    throw new Error(this.problem ?? 'The canva-mcp bridge is not running.');
  }

  async status(): Promise<BridgeStatus> {
    await this.settle();
    if (this.server) return { mode: 'owner', ...this.server.status() };
    if (this.relay) {
      const owner = await this.relay.call<OwnerStatus>({ type: 'relay', op: 'status' }, 5000);
      return { mode: 'relay', via: this.relay.url, ...owner };
    }
    return { mode: 'unavailable', problem: this.problem ?? 'The canva-mcp bridge is not running.' };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.relay?.close();
    await this.server?.stop();
  }
}
