import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { folderId } from '../canva/ids.js';
import type { Asset, Design, Thumbnail } from '../canva/types.js';
import { continuationParam, guarded, iso, json, presentDesign, toolName, type ToolDeps } from './common.js';

interface Folder {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  thumbnail?: Thumbnail;
}

type FolderItem =
  | { type: 'folder'; folder: Folder }
  | { type: 'design'; design: Design }
  | { type: 'image'; image: Asset }
  | { type: 'brand_template'; brand_template: { id: string; title: string; view_url: string; create_url: string; updated_at: number } };

function presentFolder(f: Folder) {
  return { id: f.id, name: f.name, created_at: iso(f.created_at), updated_at: iso(f.updated_at) };
}

function presentItem(item: FolderItem) {
  switch (item.type) {
    case 'folder':
      return { type: 'folder', ...presentFolder(item.folder) };
    case 'design':
      return { type: 'design', ...presentDesign(item.design, false) };
    case 'image':
      return { type: 'image', id: item.image.id, name: item.image.name, tags: item.image.tags, updated_at: iso(item.image.updated_at) };
    case 'brand_template': {
      const t = item.brand_template;
      return { type: 'brand_template', id: t.id, title: t.title, view_url: t.view_url, create_url: t.create_url, updated_at: iso(t.updated_at) };
    }
    default:
      return item;
  }
}

const folderParam = z
  .string()
  .min(1)
  .describe('A folder ID or canva.com/folder/... link, "root" for the top level of the user\'s Projects, or "uploads" for their Uploads folder.');

export function registerFolderTools(server: McpServer, deps: ToolDeps) {
  const n = (base: Parameters<typeof toolName>[1]) => toolName(deps.config.toolPrefix, base);
  const { rest } = deps;

  server.registerTool(
    n('create-folder'),
    {
      title: 'Create folder',
      description: 'Creates a folder in the user\'s Canva Projects (at the top level, in Uploads, or inside another folder).',
      inputSchema: {
        name: z.string().min(1).max(255),
        parentFolderId: folderParam.optional().describe('Where to create it: a folder ID or link, "root" (default) or "uploads".'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { folder } = await rest.post<{ folder: Folder }>('/v1/folders', { name: args.name, parent_folder_id: folderId(args.parentFolderId ?? 'root') });
      return { content: [json(presentFolder(folder))] };
    }),
  );

  server.registerTool(
    n('list-folder-items'),
    {
      title: 'List folder items',
      description: 'Lists the folders, designs, images and brand templates inside a folder. Use "root" to browse the top level of the user\'s Projects.',
      inputSchema: {
        folderId: folderParam.optional().describe('The folder to list. Defaults to "root".'),
        itemTypes: z.array(z.enum(['design', 'folder', 'image', 'brand_template'])).optional().describe('Only these kinds of items.'),
        sortBy: z
          .enum(['created_ascending', 'created_descending', 'modified_ascending', 'modified_descending', 'title_ascending', 'title_descending'])
          .optional()
          .describe('Sort order (default modified_descending).'),
        pinnedOnly: z.boolean().optional().describe('Only pinned items.'),
        limit: z.number().int().min(1).max(100).optional().describe('Items per page (default 50).'),
        continuation: continuationParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ items: FolderItem[]; continuation?: string }>(`/v1/folders/${encodeURIComponent(folderId(args.folderId ?? 'root'))}/items`, {
        item_types: args.itemTypes,
        sort_by: args.sortBy,
        pin_status: args.pinnedOnly ? 'pinned' : undefined,
        limit: args.limit,
        continuation: args.continuation,
      });
      return { content: [json({ items: res.items.map(presentItem), continuation: res.continuation })] };
    }),
  );

  server.registerTool(
    n('move-item-to-folder'),
    {
      title: 'Move item to folder',
      description:
        'Moves a design, folder or image into another folder ("root" for the top level of Projects). Video assets can\'t be moved. ' +
        'An item that sits in several folders can\'t be moved this way.',
      inputSchema: {
        itemId: z.string().min(1).describe('The ID of the design, folder or image to move.'),
        toFolderId: folderParam.describe('The destination folder ID or link, or "root".'),
      },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      await rest.post('/v1/folders/move', { item_id: args.itemId, to_folder_id: folderId(args.toFolderId) });
      return { content: [json({ moved: args.itemId, to: folderId(args.toFolderId) })] };
    }),
  );
}
