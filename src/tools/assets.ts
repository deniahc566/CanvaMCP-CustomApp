import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { download } from '../canva/rest.js';
import type { Asset, AssetUploadJob, ImageGenerationJob, ImageTransformationJob } from '../canva/types.js';
import { errorMessage, sniffImage } from '../util.js';
import { finishJob, guarded, image, iso, jobFailed, jobPending, json, JOB_PATHS, toolName, type ToolDeps } from './common.js';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Canva's asset name limit (unencoded). */
const MAX_ASSET_NAME = 50;

function presentAsset(a: Asset) {
  return { id: a.id, type: a.type, name: a.name, tags: a.tags, created_at: iso(a.created_at), updated_at: iso(a.updated_at), thumbnail: a.thumbnail };
}

export function registerAssetTools(server: McpServer, deps: ToolDeps) {
  const n = (base: Parameters<typeof toolName>[1]) => toolName(deps.config.toolPrefix, base);
  const { rest } = deps;

  server.registerTool(
    n('upload-asset-from-url'),
    {
      title: 'Upload asset from URL',
      description:
        `Uploads an image or video from a public URL to the user\'s Canva Uploads, returning the asset ID to use in ${n('create-design')} or ${n('autofill-design')}. ` +
        'Supported: JPEG, PNG, HEIC, GIF, TIFF, WebP, SVG images and common video formats.',
      inputSchema: {
        url: z.string().min(8).max(2048).describe('Publicly reachable URL of the file.'),
        name: z.string().min(1).max(255).describe('Name for the asset in Canva.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { job } = await rest.post<{ job: AssetUploadJob }>('/v1/url-asset-uploads', { url: args.url, name: args.name });
      return finishJob(deps, 'url-asset-upload', job, (j) => ({ asset: j.asset && presentAsset(j.asset) }));
    }),
  );

  server.registerTool(
    n('upload-asset-from-file'),
    {
      title: 'Upload asset from file',
      description:
        `Uploads an image or video on this computer to the user\'s Canva Uploads, returning the asset ID to use in ${n('create-design')} or ${n('autofill-design')}. ` +
        'Supported: JPEG, PNG, HEIC, GIF, TIFF, WebP, SVG images and common video formats.',
      inputSchema: {
        filePath: z.string().min(1).describe('Absolute path of the local file to upload.'),
        name: z.string().min(1).optional().describe(`Name for the asset in Canva (max ${MAX_ASSET_NAME} characters). Defaults to the file name.`),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const stat = await fs.stat(args.filePath);
      if (!stat.isFile()) throw new Error(`${args.filePath} is not a file.`);
      if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`${args.filePath} is ${stat.size} bytes, over the ${MAX_UPLOAD_BYTES}-byte limit.`);
      const name = (args.name ?? path.parse(args.filePath).name).slice(0, MAX_ASSET_NAME);
      const { job } = await rest.request<{ job: AssetUploadJob }>('POST', '/v1/asset-uploads', {
        body: await fs.readFile(args.filePath),
        headers: { 'Asset-Upload-Metadata': JSON.stringify({ name_base64: Buffer.from(name, 'utf8').toString('base64') }) },
      });
      return finishJob(deps, 'asset-upload', job, (j) => ({ asset: j.asset && presentAsset(j.asset) }));
    }),
  );

  server.registerTool(
    n('get-assets'),
    {
      title: 'Get assets',
      description: 'Gets the metadata of one or more uploaded assets (images and videos) by ID: name, type, tags, dates and a thumbnail URL.',
      inputSchema: {
        assetIds: z.array(z.string().min(1)).min(1).max(20).describe('Asset IDs to look up.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const assets = await Promise.all(
        args.assetIds.map((id) =>
          rest.get<{ asset: Asset }>(`/v1/assets/${encodeURIComponent(id)}`).then(
            (res) => presentAsset(res.asset),
            (err) => ({ id, error: errorMessage(err) }),
          ),
        ),
      );
      return { content: [json({ assets })] };
    }),
  );

  server.registerTool(
    n('update-asset'),
    {
      title: 'Update asset',
      description: 'Renames an uploaded asset and/or replaces its tags (tags given here replace all existing ones).',
      inputSchema: {
        assetId: z.string().min(1),
        name: z.string().min(1).max(50).optional().describe('New name.'),
        tags: z.array(z.string().max(50)).max(50).optional().describe('The complete new list of tags.'),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      if (args.name === undefined && args.tags === undefined) throw new Error('Pass name, tags, or both.');
      const { asset } = await rest.patch<{ asset: Asset }>(`/v1/assets/${encodeURIComponent(args.assetId)}`, { name: args.name, tags: args.tags });
      return { content: [json(presentAsset(asset))] };
    }),
  );

  server.registerTool(
    n('generate-image'),
    {
      title: 'Generate image',
      description:
        'Generates an image with Canva AI from a text prompt and shows it. Optionally saves it to the user\'s Uploads so it can be placed in designs. ' +
        `Uses Canva AI credits and needs the image_generation capability (check ${n('whoami')}). Download URLs are valid for 24 hours. (Canva preview API.)`,
      inputSchema: {
        prompt: z.string().min(1).max(10_000).describe('A plain-text description of the image.'),
        aspectRatio: z.enum(['square', 'landscape', 'portrait', 'landscape_3_2', 'portrait_2_3', 'portrait_4_5']).optional(),
        model: z.enum(['craft_v1_2k', 'lucid_origin', 'z_image_turbo']).optional().describe('Leave unset so Canva picks the best available model.'),
        saveToUploads: z.boolean().optional().describe('Save the image as an asset in the user\'s Uploads (returns its asset ID).'),
        assetName: z.string().min(1).max(255).optional().describe('Asset name when saveToUploads is true.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { job: started } = await rest.post<{ job: ImageGenerationJob }>('/v1/image-generations', {
        prompt: args.prompt,
        aspect_ratio: args.aspectRatio,
        model: args.model,
        idempotency_key: crypto.randomUUID(),
        asset_upload: args.saveToUploads ? { type: 'upload', asset_name: args.assetName } : { type: 'none' },
      });
      const { job, done } = await rest.waitForJob(JOB_PATHS['image-generation'], started, Math.max(deps.config.jobTimeoutMs, 120_000));
      if (!done) return jobPending(deps, 'image-generation', job);
      if (job.status === 'failed' || !job.result) return jobFailed('image-generation', job);
      const generated = job.result.image;
      const summary = json({ url: generated.url, width: generated.width, height: generated.height, asset: generated.asset });
      try {
        const { data, contentType } = await download(generated.url, 20 * 1024 * 1024);
        const format = sniffImage(data);
        return { content: [image(data.toString('base64'), format ? `image/${format}` : contentType), summary] };
      } catch {
        return { content: [summary] };
      }
    }),
  );

  server.registerTool(
    n('remove-background'),
    {
      title: 'Remove background',
      description:
        'Removes the background from an uploaded image asset, keeping the foreground subject on a transparent background. ' +
        'Creates a new asset; the original is unchanged. Needs the background_removal capability (a paid Canva plan). (Canva preview API.)',
      inputSchema: {
        assetId: z.string().min(1).describe('The image asset to process.'),
        name: z.string().min(1).max(255).optional().describe('Name for the new asset.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { job } = await rest.post<{ job: ImageTransformationJob }>('/v1/image-transformations', {
        asset_id: args.assetId,
        name: args.name,
        transformations: [{ type: 'background_removal' }],
      });
      return finishJob(deps, 'image-transformation', job, (j) => ({ asset: j.result && presentAsset(j.result.asset) }));
    }),
  );
}
