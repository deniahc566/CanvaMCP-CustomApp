import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { designId } from '../canva/ids.js';
import { download } from '../canva/rest.js';
import type { Design, DesignImportJob, DesignPage, DesignResultJob, ExportJob } from '../canva/types.js';
import { exportExtension, safeFileName, sniffImage } from '../util.js';
import {
  continuationParam,
  designIdParam,
  designTypeParam,
  finishJob,
  guarded,
  image,
  json,
  pagesParam,
  presentDesign,
  toolName,
  type ToolDeps,
} from './common.js';

const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
/** Canva's import title limit (unencoded). */
const MAX_IMPORT_TITLE = 50;

const EXPORT_TYPES = ['pdf', 'jpg', 'png', 'pptx', 'gif', 'mp4', 'html_bundle', 'html_standalone', 'csv'] as const;
const MP4_QUALITIES = [
  'horizontal_480p',
  'horizontal_720p',
  'horizontal_1080p',
  'horizontal_4k',
  'vertical_480p',
  'vertical_720p',
  'vertical_1080p',
  'vertical_4k',
] as const;

interface ExportArgs {
  type: (typeof EXPORT_TYPES)[number];
  pages?: number[];
  exportQuality?: 'regular' | 'pro';
  quality?: number;
  videoQuality?: (typeof MP4_QUALITIES)[number];
  width?: number;
  height?: number;
  lossless?: boolean;
  transparentBackground?: boolean;
  asSingleImage?: boolean;
  paperSize?: 'a4' | 'a3' | 'letter' | 'legal';
}

/** Build the API's per-type format object, dropping options that type doesn't take. */
function exportFormat(a: ExportArgs): Record<string, unknown> {
  const f: Record<string, unknown> = { type: a.type, pages: a.pages };
  const quality = ['pdf', 'jpg', 'png', 'gif', 'mp4'].includes(a.type);
  if (quality) f.export_quality = a.exportQuality;
  if (['jpg', 'png', 'gif'].includes(a.type)) Object.assign(f, { width: a.width, height: a.height });
  if (a.type === 'pdf') f.size = a.paperSize;
  if (a.type === 'jpg') f.quality = a.quality ?? 90;
  if (a.type === 'png') Object.assign(f, { lossless: a.lossless, transparent_background: a.transparentBackground, as_single_image: a.asSingleImage });
  if (a.type === 'mp4') f.quality = a.videoQuality ?? 'horizontal_1080p';
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

export function registerDesignTools(server: McpServer, deps: ToolDeps) {
  const n = (base: Parameters<typeof toolName>[1]) => toolName(deps.config.toolPrefix, base);
  const { rest } = deps;

  server.registerTool(
    n('search-designs'),
    {
      title: 'Search designs',
      description:
        'Searches the designs in the user\'s Canva projects by title and content, or lists them all when query is omitted. ' +
        'Returns IDs, titles, page counts, dates and edit/view links (temporary, only usable by the signed-in user).',
      inputSchema: {
        query: z.string().max(255).optional().describe('Search terms. Omit to list all designs.'),
        ownership: z.enum(['any', 'owned', 'shared']).optional().describe('Designs the user owns, ones shared with them, or both (default "any").'),
        sortBy: z
          .enum(['relevance', 'modified_descending', 'modified_ascending', 'title_descending', 'title_ascending'])
          .optional()
          .describe('Sort order. Defaults to relevance when searching.'),
        limit: z.number().int().min(1).max(100).optional().describe('Results per page (default 25).'),
        continuation: continuationParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ items: Design[]; continuation?: string }>('/v1/designs', {
        query: args.query,
        ownership: args.ownership,
        sort_by: args.sortBy,
        limit: args.limit,
        continuation: args.continuation,
      });
      return { content: [json({ designs: res.items.map((d) => presentDesign(d, false)), continuation: res.continuation })] };
    }),
  );

  server.registerTool(
    n('get-design'),
    {
      title: 'Get design',
      description: 'Gets a design\'s metadata: title, owner, page count, design types, dates, edit/view links and a thumbnail URL (valid 15 minutes).',
      inputSchema: { designId: designIdParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const { design } = await rest.get<{ design: Design }>(`/v1/designs/${encodeURIComponent(designId(args.designId))}`);
      return { content: [json(presentDesign(design))] };
    }),
  );

  server.registerTool(
    n('get-design-pages'),
    {
      title: 'Get design pages',
      description: 'Lists the pages of a design with their page numbers, dimensions and thumbnail URLs. Some design types (e.g. Canva Docs, whiteboards) have no pages.',
      inputSchema: {
        designId: designIdParam,
        offset: z.number().int().min(1).max(500).optional().describe('The first page number to return (1-based, default 1).'),
        limit: z.number().int().min(1).max(200).optional().describe('How many pages to return (default 50).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ items: DesignPage[] }>(`/v1/designs/${encodeURIComponent(designId(args.designId))}/pages`, {
        offset: args.offset,
        limit: args.limit,
      });
      return { content: [json({ pages: res.items.map(({ page_number, id, dimensions, design_type, thumbnail }) => ({ page_number, id, dimensions, design_type, thumbnail })) })] };
    }),
  );

  server.registerTool(
    n('get-design-thumbnail'),
    {
      title: 'Get design thumbnail',
      description: 'Returns a thumbnail image of a design (its first page) or of one page, so you can see what the design looks like. For full-resolution output use export-design.',
      inputSchema: {
        designId: designIdParam,
        pageNumber: z.number().int().min(1).max(500).optional().describe('The page to show (1-based). Omit for the design\'s own thumbnail.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const id = designId(args.designId);
      let thumb;
      if (args.pageNumber) {
        const res = await rest.get<{ items: DesignPage[] }>(`/v1/designs/${encodeURIComponent(id)}/pages`, { offset: args.pageNumber, limit: 1 });
        thumb = res.items[0]?.thumbnail;
        if (!res.items.length) throw new Error(`Page ${args.pageNumber} does not exist in this design.`);
      } else {
        thumb = (await rest.get<{ design: Design }>(`/v1/designs/${encodeURIComponent(id)}`)).design.thumbnail;
      }
      if (!thumb) throw new Error('Canva has no thumbnail for this design or page yet.');
      const { data, contentType } = await download(thumb.url, 20 * 1024 * 1024);
      const format = sniffImage(data);
      const mimeType = format ? `image/${format}` : contentType;
      return { content: [image(data.toString('base64'), mimeType), json({ width: thumb.width, height: thumb.height, url: thumb.url })] };
    }),
  );

  server.registerTool(
    n('get-export-formats'),
    {
      title: 'Get export formats',
      description: 'Lists the file formats a design can be exported to (pdf, jpg, png, svg, pptx, gif, mp4, html_bundle, html_standalone, csv) and which pages support each.',
      inputSchema: { designId: designIdParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ formats: unknown }>(`/v1/designs/${encodeURIComponent(designId(args.designId))}/export-formats`);
      return { content: [json(res.formats)] };
    }),
  );

  server.registerTool(
    n('create-design'),
    {
      title: 'Create design',
      description:
        'Creates a new, blank Canva design of a preset type (doc, email, presentation, whiteboard) or custom pixel size, optionally with an uploaded image asset placed in it. ' +
        `Returns the design with its edit link. To fill a design with AI-generated content use ${n('generate-design')}; to copy one use ${n('copy-design')}.`,
      inputSchema: {
        designType: designTypeParam.optional(),
        title: z.string().min(1).max(255).optional().describe('The design title.'),
        assetId: z.string().optional().describe('An image asset ID to insert into the design (from an upload tool or get-assets).'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      if (!args.designType && !args.assetId) throw new Error('Pass designType, assetId, or both.');
      const { design } = await rest.post<{ design: Design }>('/v1/designs', {
        type: 'type_and_asset',
        design_type: args.designType,
        asset_id: args.assetId,
        title: args.title,
      });
      return { content: [json(presentDesign(design))] };
    }),
  );

  server.registerTool(
    n('copy-design'),
    {
      title: 'Copy design',
      description: 'Creates a copy of an existing design, optionally with only some of its pages. The copy is saved to the user\'s projects. (Canva preview API.)',
      inputSchema: { designId: designIdParam, pageNumbers: pagesParam },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { design } = await rest.post<{ design: Design }>('/v1/designs', {
        type: 'design',
        design_id: designId(args.designId),
        page_numbers: args.pageNumbers,
      });
      return { content: [json(presentDesign(design))] };
    }),
  );

  server.registerTool(
    n('create-design-from-brand-template'),
    {
      title: 'Create design from brand template',
      description:
        `Creates a new design from a brand template, as is (copying its pages). To fill the template's data fields with text, images or chart data, use ${n('autofill-design')} instead. ` +
        'Brand templates need a Canva plan that includes them. (Canva preview API.)',
      inputSchema: {
        brandTemplateId: z.string().min(1).describe(`The brand template ID, from ${n('search-brand-templates')}.`),
        pageNumbers: pagesParam,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { design } = await rest.post<{ design: Design }>('/v1/designs', {
        type: 'brand_template',
        brand_template_id: args.brandTemplateId,
        page_numbers: args.pageNumbers,
      });
      return { content: [json(presentDesign(design))] };
    }),
  );

  server.registerTool(
    n('resize-design'),
    {
      title: 'Resize design',
      description:
        'Creates a resized copy of a design at a preset type or custom pixel size (Canva Magic Resize); the original is unchanged. ' +
        'Needs a Canva plan with premium features (Free plans get a limited trial). Canva Docs can\'t be resized and other designs can\'t become Docs.',
      inputSchema: { designId: designIdParam, designType: designTypeParam },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { job } = await rest.post<{ job: DesignResultJob }>('/v1/resizes', { design_id: designId(args.designId), design_type: args.designType });
      return finishJob(deps, 'resize', job, (j) => ({ design: presentDesign(j.result!.design), trial_information: j.result?.trial_information }));
    }),
  );

  const mergeOperation = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('insert_pages'),
      sourceDesignId: designIdParam.describe('The design to take pages from.'),
      pageNumbers: pagesParam.describe('Pages of the source design to insert (1-based). Omit for all.'),
      afterPageNumber: z.number().int().min(0).optional().describe('Insert after this page of the target (0 = at the start). Defaults to the end.'),
    }),
    z.object({
      type: z.literal('move_pages'),
      fromPageNumbers: z.array(z.number().int().min(1)).min(1).describe('Pages to move, as numbered when this operation runs.'),
      toAfterPageNumber: z.number().int().min(0).describe('Move them after this page (0 = to the start).'),
    }),
    z.object({
      type: z.literal('delete_pages'),
      pageNumbers: z.array(z.number().int().min(1)).min(1).describe('Pages to delete, as numbered when this operation runs.'),
    }),
  ]);

  server.registerTool(
    n('merge-designs'),
    {
      title: 'Merge designs',
      description:
        'Builds a new design from pages of other designs, or edits the page list of an existing design (insert pages from other designs, move pages, delete pages). ' +
        'Operations run in order, and page numbers refer to the layout as it stands when each one runs. Creating a new design only supports insert_pages. (Canva preview API.)',
      inputSchema: {
        targetDesignId: designIdParam.optional().describe('The design to modify. Omit to create a new design instead.'),
        title: z.string().min(1).max(255).optional().describe('Title for the new design (required when targetDesignId is omitted), or a new title for the modified one.'),
        operations: z.array(mergeOperation).min(1),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const operations = args.operations.map((op) => {
        if (op.type === 'insert_pages') {
          return {
            type: op.type,
            source: { type: 'design', design_id: designId(op.sourceDesignId), page_numbers: op.pageNumbers },
            after_page_number: op.afterPageNumber,
          };
        }
        if (op.type === 'move_pages') return { type: op.type, from_page_numbers: op.fromPageNumbers, to_after_page_number: op.toAfterPageNumber };
        return { type: op.type, page_numbers: op.pageNumbers };
      });
      let body;
      if (args.targetDesignId) {
        body = { type: 'modify_existing_design', design_id: designId(args.targetDesignId), operations, title: args.title };
      } else {
        if (!args.title) throw new Error('title is required when creating a new design (targetDesignId omitted).');
        if (operations.some((op) => op.type !== 'insert_pages')) throw new Error('A new design can only be built with insert_pages operations.');
        body = { type: 'create_new_design', operations, title: args.title };
      }
      const { job } = await rest.post<{ job: DesignResultJob }>('/v1/merges', body);
      return finishJob(deps, 'merge', job, (j) => ({ design: presentDesign(j.result!.design) }));
    }),
  );

  server.registerTool(
    n('generate-design'),
    {
      title: 'Generate design',
      description:
        'Generates a new Canva Doc or presentation with AI from a written brief, optionally following a slide-by-slide outline. ' +
        'Put the subject, purpose, audience, required wording, tone and visual direction in the brief. Uses the account\'s Canva AI credits, ' +
        `and needs the design_generation capability (check ${n('whoami')}). (Canva preview API.)`,
      inputSchema: {
        brief: z.string().min(1).max(5000).describe('What to generate: subject, purpose, required wording, tone and visual direction.'),
        designType: z.enum(['doc', 'presentation']).describe('Generate a Canva Doc or a presentation.'),
        outline: z
          .array(
            z.object({
              title: z.string().min(1).max(255),
              description: z.string().min(1).max(2000).optional(),
              points: z.array(z.string().min(1).max(1000)).optional(),
            }),
          )
          .optional()
          .describe('Presentations only: the slides to produce, in order.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      if (args.outline && args.designType !== 'presentation') throw new Error('outline is only supported when designType is "presentation".');
      const res = await rest.post<{ job: DesignResultJob; quota_usage?: unknown }>('/v1/generations', {
        brief: args.brief,
        design_type: { type: 'preset', name: args.designType },
        outline: args.outline ? { sections: args.outline } : undefined,
      });
      return finishJob(deps, 'design-generation', res.job, (j) => ({ design: presentDesign(j.result!.design), quota_usage: res.quota_usage }), Math.max(deps.config.jobTimeoutMs, 180_000));
    }),
  );

  server.registerTool(
    n('export-design'),
    {
      title: 'Export design',
      description:
        'Exports a design to a file (pdf, jpg, png, pptx, gif, mp4, html_bundle, html_standalone or csv) and returns download URLs, valid for 24 hours. ' +
        `With download: true the files are also saved locally and their paths returned. Check ${n('get-export-formats')} first if unsure a format applies. ` +
        'Fails with license_required when the design uses premium elements the user has no license for.',
      inputSchema: {
        designId: designIdParam,
        format: z.object({
          type: z.enum(EXPORT_TYPES),
          pages: pagesParam,
          exportQuality: z.enum(['regular', 'pro']).optional().describe('pdf/jpg/png/gif/mp4: "pro" uses premium quality where the plan allows. Default "regular".'),
          quality: z.number().int().min(1).max(100).optional().describe('jpg only: compression quality 1-100 (default 90).'),
          videoQuality: z.enum(MP4_QUALITIES).optional().describe('mp4 only: orientation and resolution (default horizontal_1080p).'),
          width: z.number().int().min(40).max(25000).optional().describe('jpg/png/gif: output width in pixels; keeps aspect ratio if only one side is given.'),
          height: z.number().int().min(40).max(25000).optional().describe('jpg/png/gif: output height in pixels.'),
          lossless: z.boolean().optional().describe('png only: export without compression (default true).'),
          transparentBackground: z.boolean().optional().describe('png only: transparent background (paid plans).'),
          asSingleImage: z.boolean().optional().describe('png only: merge all pages into one image.'),
          paperSize: z.enum(['a4', 'a3', 'letter', 'legal']).optional().describe('pdf of a Canva Doc only: paper size.'),
        }),
        download: z.boolean().optional().describe('Also save the exported files locally and return their paths.'),
        downloadDir: z.string().optional().describe('Folder to save into when download is true. Defaults to CANVA_DOWNLOAD_DIR.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const id = designId(args.designId);
      const { job } = await rest.post<{ job: ExportJob }>('/v1/exports', { design_id: id, format: exportFormat(args.format) });
      return finishJob(deps, 'export', job, async (j) => {
        const urls = j.urls ?? [];
        if (!args.download) return { status: 'success', format: args.format.type, urls };
        const dir = path.resolve(args.downloadDir ?? path.join(deps.config.downloadDir, `${safeFileName(id)}-${Date.now()}`));
        await fs.mkdir(dir, { recursive: true });
        const ext = exportExtension(args.format.type);
        const files: string[] = [];
        for (const [i, url] of urls.entries()) {
          const { data } = await download(url);
          const file = path.join(dir, urls.length > 1 ? `${safeFileName(id)}-${i + 1}.${ext}` : `${safeFileName(id)}.${ext}`);
          await fs.writeFile(file, data);
          files.push(file);
        }
        return { status: 'success', format: args.format.type, files, urls };
      });
    }),
  );

  server.registerTool(
    n('import-design-from-url'),
    {
      title: 'Import design from URL',
      description:
        'Imports a file from a public URL as a new editable Canva design: PDF, PowerPoint (pptx), Keynote, Word (docx), Adobe Illustrator/Photoshop and more. ' +
        'Large files may be split into several designs.',
      inputSchema: {
        url: z.string().min(1).max(2048).describe('Publicly reachable URL of the file.'),
        title: z.string().min(1).max(255).describe('Title for the new design.'),
        mimeType: z.string().min(1).max(100).optional().describe('The file\'s MIME type, if Canva can\'t tell from the file.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { job } = await rest.post<{ job: DesignImportJob }>('/v1/url-imports', { url: args.url, title: args.title, mime_type: args.mimeType });
      return finishJob(deps, 'url-import', job, (j) => ({ designs: (j.result?.designs ?? []).map((d) => presentDesign(d)) }));
    }),
  );

  server.registerTool(
    n('import-design-from-file'),
    {
      title: 'Import design from file',
      description:
        'Imports a file on this computer as a new editable Canva design: PDF, PowerPoint (pptx), Keynote, Word (docx), Adobe Illustrator/Photoshop and more. ' +
        'Large files may be split into several designs.',
      inputSchema: {
        filePath: z.string().min(1).describe('Absolute path of the local file to import.'),
        title: z.string().min(1).optional().describe(`Title for the new design (max ${MAX_IMPORT_TITLE} characters). Defaults to the file name.`),
        mimeType: z.string().min(1).max(100).optional().describe('The file\'s MIME type, if Canva can\'t tell from the file.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const stat = await fs.stat(args.filePath);
      if (!stat.isFile()) throw new Error(`${args.filePath} is not a file.`);
      if (stat.size > MAX_IMPORT_BYTES) throw new Error(`${args.filePath} is ${stat.size} bytes, over the ${MAX_IMPORT_BYTES}-byte limit.`);
      const title = (args.title ?? path.parse(args.filePath).name).slice(0, MAX_IMPORT_TITLE);
      const metadata = { title_base64: Buffer.from(title, 'utf8').toString('base64'), mime_type: args.mimeType };
      const { job } = await rest.request<{ job: DesignImportJob }>('POST', '/v1/imports', {
        body: await fs.readFile(args.filePath),
        headers: { 'Import-Metadata': JSON.stringify(metadata) },
      });
      return finishJob(deps, 'design-import', job, (j) => ({ designs: (j.result?.designs ?? []).map((d) => presentDesign(d)) }));
    }),
  );
}
