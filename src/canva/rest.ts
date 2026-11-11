import type { Config } from '../config.js';
import { sleep } from '../util.js';
import type { TokenManager } from './auth.js';

export class CanvaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly path: string,
  ) {
    super(message);
    this.name = 'CanvaApiError';
  }
}

type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  /** Sent as application/json. */
  json?: unknown;
  /** Sent as application/octet-stream (uploads and imports). */
  body?: Buffer;
  headers?: Record<string, string>;
}

export interface Job {
  id?: string;
  status: 'in_progress' | 'success' | 'failed';
  error?: { code: string; message: string };
}

const MAX_RETRIES = 3;
/** Wait at most this long on a 429 before giving up and reporting the limit to the caller. */
const MAX_RETRY_WAIT_MS = 20_000;

function hint(status: number): string {
  switch (status) {
    case 401:
      return 'The Canva session is no longer valid. Call the login tool to sign in again.';
    case 403:
      return 'Canva refused this call. Check that the scope this tool needs is enabled on your integration in the Developer Portal, that you signed in again after enabling it, and that your Canva plan includes the feature.';
    case 404:
      return 'Not found. Check the ID: design IDs look like "DAF..." and a canva.com design URL is also accepted.';
    case 429:
      return 'Canva rate limit reached. Wait a minute before retrying.';
    default:
      return '';
  }
}

function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return 1000 * 2 ** attempt;
}

export class CanvaRestClient {
  constructor(
    private config: Config,
    readonly auth: TokenManager,
  ) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.config.apiBase + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      // Canva's array query parameters (e.g. item_types) are comma-separated, not repeated.
      if (Array.isArray(v)) {
        if (v.length) url.searchParams.set(k, v.join(','));
      } else {
        url.searchParams.set(k, String(v));
      }
    }

    let token = await this.auth.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...opts.headers };
      let body: string | Buffer | undefined;
      if (opts.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      } else if (opts.body) {
        headers['Content-Type'] ??= 'application/octet-stream';
        body = opts.body;
      }

      const res = await fetch(url, { method, headers, body: body as BodyInit | undefined });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.auth.refresh(token);
        continue;
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(res.headers.get('retry-after'), attempt);
        if (wait <= MAX_RETRY_WAIT_MS) {
          await sleep(wait);
          continue;
        }
      }
      if (res.status === 204) return undefined as T;

      const raw = await res.text();
      let data: unknown;
      try {
        data = raw ? JSON.parse(raw) : undefined;
      } catch {
        data = undefined;
      }
      if (!res.ok) {
        const err = (data ?? {}) as { code?: string; message?: string };
        const detail = err.message ?? (raw.slice(0, 300) || res.statusText);
        const extra = hint(res.status);
        throw new CanvaApiError(
          `Canva API ${res.status}${err.code ? ` ${err.code}` : ''} on ${method} ${path}: ${detail}${extra ? ` (${extra})` : ''}`,
          res.status,
          err.code,
          path,
        );
      }
      return data as T;
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, json: unknown): Promise<T> {
    return this.request<T>('POST', path, { json });
  }

  patch<T>(path: string, json: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { json });
  }

  /**
   * Poll an async job until it leaves `in_progress` or `timeoutMs` passes. `path(id)` is the job's GET endpoint.
   * Returns `done: false` with the last seen job on timeout, so the caller can hand back the job ID.
   */
  async waitForJob<J extends Job>(path: (id: string) => string, job: J, timeoutMs: number): Promise<{ job: J; done: boolean }> {
    const deadline = Date.now() + timeoutMs;
    let delay = 1000;
    while (job.status === 'in_progress') {
      if (!job.id) throw new Error('Canva returned an in-progress job without an ID.');
      const left = deadline - Date.now();
      if (left <= 0) return { job, done: false };
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 1.5, 5000);
      job = (await this.get<{ job: J }>(path(job.id))).job;
    }
    return { job, done: true };
  }
}

/** Download a pre-signed Canva URL (thumbnails, exports, generated images). These need no auth header. */
export async function download(url: string, maxBytes = 200 * 1024 * 1024): Promise<{ data: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status} (${url.split('?')[0]}). Canva download links expire; fetch a fresh one.`);
  const length = Number(res.headers.get('content-length'));
  if (length > maxBytes) throw new Error(`The file is ${length} bytes, over the ${maxBytes}-byte limit.`);
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
