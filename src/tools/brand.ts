import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { designId } from '../canva/ids.js';
import type { DesignResultJob } from '../canva/types.js';
import { continuationParam, designIdParam, finishJob, guarded, iso, json, presentDesign, toolName, type ToolDeps } from './common.js';

interface BrandTemplate {
  id: string;
  title: string;
  view_url: string;
  create_url: string;
  thumbnail?: { width: number; height: number; url: string };
  created_at: number;
  updated_at: number;
}

function presentTemplate(t: BrandTemplate) {
  return { id: t.id, title: t.title, view_url: t.view_url, create_url: t.create_url, created_at: iso(t.created_at), updated_at: iso(t.updated_at) };
}

const dataTable = z
  .record(z.string(), z.unknown())
  .describe(
    'Tabular data in the Canva API shape: {"column_configs"?: [{"name": "Month", "type": "string"}], "rows": [{"cells": [{"type": "string", "value": "Jan"}, {"type": "number", "value": 42}]}]}. ' +
      'Without column_configs the first row is treated as headers.',
  );

const datasetValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().describe('Text for the field.') }),
  z.object({ type: z.literal('image'), assetId: z.string().min(1).describe('An image asset ID (upload it first).') }),
  z.object({ type: z.literal('video'), assetId: z.string().min(1).describe('A video asset to put in an image field.') }),
  z.object({ type: z.literal('chart'), chartData: dataTable }),
  z.object({ type: z.literal('sheet'), sheetData: dataTable }),
]);

function apiValue(v: z.infer<typeof datasetValue>) {
  switch (v.type) {
    case 'text':
      return { type: 'text', text: v.text };
    case 'image':
    case 'video':
      return { type: v.type, asset_id: v.assetId };
    case 'chart':
      return { type: 'chart', chart_data: v.chartData };
    case 'sheet':
      return { type: 'sheet', sheet_data: v.sheetData };
  }
}

export function registerBrandTools(server: McpServer, deps: ToolDeps) {
  const n = (base: Parameters<typeof toolName>[1]) => toolName(deps.config.toolPrefix, base);
  const { rest } = deps;

  server.registerTool(
    n('search-brand-templates'),
    {
      title: 'Search brand templates',
      description:
        'Searches the brand templates of the user\'s brand (or lists them all when query is omitted). ' +
        `Set dataset to "non_empty" to get only templates with autofill data fields, for use with ${n('autofill-design')}. Needs a Canva plan with brand templates.`,
      inputSchema: {
        query: z.string().optional().describe('Search terms. Omit to list all.'),
        ownership: z.enum(['any', 'owned', 'shared']).optional(),
        sortBy: z.enum(['relevance', 'modified_descending', 'modified_ascending', 'title_descending', 'title_ascending']).optional(),
        dataset: z.enum(['any', 'non_empty']).optional().describe('"non_empty": only templates that have autofill data fields.'),
        limit: z.number().int().min(1).max(100).optional().describe('Results per page (default 25).'),
        continuation: continuationParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ items: BrandTemplate[]; continuation?: string }>('/v1/brand-templates', {
        query: args.query,
        ownership: args.ownership,
        sort_by: args.sortBy,
        dataset: args.dataset,
        limit: args.limit,
        continuation: args.continuation,
      });
      return { content: [json({ brandTemplates: res.items.map(presentTemplate), continuation: res.continuation })] };
    }),
  );

  server.registerTool(
    n('get-brand-template-dataset'),
    {
      title: 'Get brand template dataset',
      description: `Lists a brand template's autofill data fields and the kind of data each accepts (text, image, chart, sheet). Call this before ${n('autofill-design')}.`,
      inputSchema: { brandTemplateId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ dataset?: unknown }>(`/v1/brand-templates/${encodeURIComponent(args.brandTemplateId)}/dataset`);
      return { content: [json(res.dataset ?? {})] };
    }),
  );

  server.registerTool(
    n('get-design-dataset'),
    {
      title: 'Get design dataset',
      description: `Lists a design's autofill data fields and the kind of data each accepts, for designs that contain data fields. Use it before ${n('autofill-design')} with a design source.`,
      inputSchema: { designId: designIdParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ dataset?: unknown }>(`/v1/designs/${encodeURIComponent(designId(args.designId))}/dataset`);
      return { content: [json(res.dataset ?? {})] };
    }),
  );

  server.registerTool(
    n('autofill-design'),
    {
      title: 'Autofill design',
      description:
        'Fills the data fields of a brand template or design with text, images, videos, chart or sheet data. It can create a new design from a brand template, ' +
        `create a new design from a design that has data fields, or update a design in place. Field names come from ${n('get-brand-template-dataset')} or ${n('get-design-dataset')}. ` +
        'Needs Canva Pro, Teams or Enterprise.',
      inputSchema: {
        source: z.discriminatedUnion('type', [
          z.object({ type: z.literal('brand_template'), brandTemplateId: z.string().min(1), title: z.string().min(1).max(255).optional() }),
          z.object({ type: z.literal('design'), designId: designIdParam, title: z.string().min(1).max(255).optional() }),
          z.object({ type: z.literal('update_design'), designId: designIdParam.describe('The design to fill in place.') }),
        ]),
        data: z.record(z.string(), datasetValue).describe('Field name -> value, e.g. {"headline": {"type": "text", "text": "Summer sale"}}.'),
      },
      annotations: { openWorldHint: true },
    },
    guarded(async (args) => {
      const data = Object.fromEntries(Object.entries(args.data).map(([k, v]) => [k, apiValue(v)]));
      const s = args.source;
      const body =
        s.type === 'brand_template'
          ? { type: 'create_from_brand_template', brand_template_id: s.brandTemplateId, title: s.title, data }
          : s.type === 'design'
            ? { type: 'create_from_design', design_id: designId(s.designId), title: s.title, data }
            : { type: 'update_design', design_id: designId(s.designId), data };
      const { job } = await rest.post<{ job: DesignResultJob }>('/v1/autofills', body);
      return finishJob(deps, 'autofill', job, (j) => ({
        result: j.result?.type,
        design: j.result && presentDesign(j.result.design),
        trial_information: j.result?.trial_information,
      }));
    }),
  );

  server.registerTool(
    n('publish-brand-template'),
    {
      title: 'Publish brand template',
      description:
        'Publishes a design as a brand template for the user\'s brand, or updates the template it is a draft of. ' +
        'Needs the brandtemplate:content:write scope (add it to CANVA_SCOPES and the integration, then sign in again) and brand-template permissions. (Canva preview API.)',
      inputSchema: { designId: designIdParam },
      annotations: { openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.post<{ brand_template: BrandTemplate }>('/v1/brand-templates', { design_id: designId(args.designId) });
      return { content: [json(presentTemplate(res.brand_template))] };
    }),
  );
}
