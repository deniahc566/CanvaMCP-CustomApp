import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BridgeHost } from '../bridge/host.js';
import type { TokenManager } from '../canva/auth.js';
import type { CanvaRestClient, Job } from '../canva/rest.js';
import type { Design, DesignSummary } from '../canva/types.js';
import type { Config } from '../config.js';
import { errorMessage } from '../util.js';

export interface ToolDeps {
  config: Config;
  rest: CanvaRestClient;
  auth: TokenManager;
  /** The editor bridge; absent when CANVA_BRIDGE=off. */
  bridge?: BridgeHost;
}

/** Official Canva MCP tool names where one exists; the rest cover Connect API features it lacks locally (file uploads, job polling, login). */
export type ToolBase =
  // account
  | 'whoami'
  | 'login'
  | 'resolve-shortlink'
  | 'get-job'
  // designs
  | 'search-designs'
  | 'get-design'
  | 'get-design-pages'
  | 'get-design-thumbnail'
  | 'get-export-formats'
  | 'create-design'
  | 'copy-design'
  | 'create-design-from-brand-template'
  | 'resize-design'
  | 'merge-designs'
  | 'generate-design'
  | 'export-design'
  | 'import-design-from-url'
  | 'import-design-from-file'
  // assets
  | 'upload-asset-from-url'
  | 'upload-asset-from-file'
  | 'get-assets'
  | 'update-asset'
  | 'generate-image'
  | 'remove-background'
  // folders
  | 'create-folder'
  | 'list-folder-items'
  | 'move-item-to-folder'
  // comments
  | 'comment-on-design'
  | 'reply-to-comment'
  | 'get-comment-thread'
  | 'list-replies'
  // brand templates and autofill
  | 'search-brand-templates'
  | 'get-brand-template-dataset'
  | 'get-design-dataset'
  | 'autofill-design'
  | 'publish-brand-template'
  // element editing through the bridge app in the Canva editor
  | 'editor-status'
  | 'read-page'
  | 'edit-page';

/** The registered (prefixed) name of a tool. Use it everywhere a tool is mentioned to the model. */
export function toolName(prefix: string, base: ToolBase): string {
  return prefix + base;
}

/** Endpoints for reading each kind of async job. get-job and every job-starting tool share them. */
export const JOB_PATHS = {
  export: (id: string) => `/v1/exports/${encodeURIComponent(id)}`,
  'design-import': (id: string) => `/v1/imports/${encodeURIComponent(id)}`,
  'url-import': (id: string) => `/v1/url-imports/${encodeURIComponent(id)}`,
  'asset-upload': (id: string) => `/v1/asset-uploads/${encodeURIComponent(id)}`,
  'url-asset-upload': (id: string) => `/v1/url-asset-uploads/${encodeURIComponent(id)}`,
  autofill: (id: string) => `/v1/autofills/${encodeURIComponent(id)}`,
  resize: (id: string) => `/v1/resizes/${encodeURIComponent(id)}`,
  merge: (id: string) => `/v1/merges/${encodeURIComponent(id)}`,
  'design-generation': (id: string) => `/v1/generations/${encodeURIComponent(id)}`,
  'image-generation': (id: string) => `/v1/image-generations/${encodeURIComponent(id)}`,
  'image-transformation': (id: string) => `/v1/image-transformations/${encodeURIComponent(id)}`,
} as const;

export type JobKind = keyof typeof JOB_PATHS;
export const JOB_KINDS = Object.keys(JOB_PATHS) as [JobKind, ...JobKind[]];

// Shared parameter schemas. IDs are relaxed on purpose: pasted canva.com links are accepted and normalized.

export const designIdParam = z
  .string()
  .min(1)
  .describe('The design ID (e.g. "DAGQm3AbCdE") or a canva.com/design/... link to the design. For canva.link short links, call resolve-shortlink first.');

export const pagesParam = z
  .array(z.number().int().min(1))
  .optional()
  .describe('One-based page numbers to include. Omit for all pages.');

export const continuationParam = z.string().optional().describe('The continuation token from a previous page of results.');

export const designTypeParam = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('preset'),
      name: z.enum(['doc', 'email', 'presentation', 'whiteboard']).describe('Canva\'s preset design types: "doc" (Canva Docs), "email", "presentation" or "whiteboard".'),
    }),
    z.object({
      type: z.literal('custom'),
      width: z.number().int().min(40).max(8000).describe('Width in pixels (40-8000).'),
      height: z.number().int().min(40).max(8000).describe('Height in pixels (40-8000). width x height must not exceed 25,000,000.'),
    }),
  ])
  .describe('A preset type, or custom pixel dimensions (e.g. 1080x1080 for an Instagram post, 1920x1080 for a 16:9 slide).');

export function text(t: string): CallToolResult['content'][number] {
  return { type: 'text', text: t };
}

export function json(value: unknown): CallToolResult['content'][number] {
  return { type: 'text', text: JSON.stringify(value, null, 2) };
}

export function image(data: string, mimeType = 'image/png'): CallToolResult['content'][number] {
  return { type: 'image', data, mimeType };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [text(message)] };
}

/** Wrap a handler so thrown errors become MCP tool errors the model can read and act on. */
export function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(errorMessage(err));
    }
  };
}

/** Canva timestamps are Unix seconds; ISO strings are easier for the model to read and compare. */
export function iso(seconds: number | undefined): string | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

/**
 * A design as the model sees it. Thumbnail URLs are signed and long, so lists leave them out
 * (get-design-thumbnail fetches the image itself).
 */
export function presentDesign(d: DesignSummary & Partial<Design>, withThumbnail = true) {
  return {
    id: d.id,
    title: d.title,
    page_count: d.page_count,
    design_types: d.design_types,
    owner: d.owner,
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
    edit_url: d.urls?.edit_url,
    view_url: d.urls?.view_url,
    thumbnail: d.thumbnail ? (withThumbnail ? d.thumbnail : { width: d.thumbnail.width, height: d.thumbnail.height }) : undefined,
  };
}

/**
 * Wait for a job a tool just started and turn its outcome into a tool result. `present` shapes the
 * successful job for the model. On timeout the job ID is handed back with the get-job call to continue.
 */
export async function finishJob<J extends Job>(
  deps: ToolDeps,
  kind: JobKind,
  started: J,
  present: (job: J) => unknown | Promise<unknown> = (job) => job,
  timeoutMs = deps.config.jobTimeoutMs,
): Promise<CallToolResult> {
  const { job, done } = await deps.rest.waitForJob(JOB_PATHS[kind], started, timeoutMs);
  if (!done) return jobPending(deps, kind, job);
  if (job.status === 'failed') return jobFailed(kind, job);
  return { content: [json(await present(job))] };
}

/** Result for a job still running after the wait: hands back the ID and the get-job call that continues it. */
export function jobPending(deps: ToolDeps, kind: JobKind, job: Job): CallToolResult {
  return {
    content: [
      json({
        status: 'in_progress',
        kind,
        jobId: job.id,
        next: `Canva is still working on this. Call ${toolName(deps.config.toolPrefix, 'get-job')} with kind "${kind}" and jobId "${job.id}" to check again.`,
      }),
    ],
  };
}

export function jobFailed(kind: JobKind, job: Job): CallToolResult {
  return fail(`The Canva ${kind} job failed${job.error ? ` (${job.error.code}): ${job.error.message}` : '.'}`);
}
