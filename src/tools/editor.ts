import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DesignContext, EditOperation, EditPageResult, ImageMimeType, PageContent } from '../bridge/protocol.js';
import { normalizeShapePath } from '../canva/shape-path.js';
import { errorMessage } from '../util.js';
import { guarded, json, toolName, type ToolDeps } from './common.js';

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex color like "#1a73e8".')
  // Canva rejects uppercase hex ("invalid argument"), so accept either and send lowercase.
  .toLowerCase()
  .describe('Hex color, e.g. "#1a73e8".');

const pathData = z
  .string()
  .min(1)
  .transform((d, ctx) => {
    try {
      return normalizeShapePath(d);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: errorMessage(err) });
      return z.NEVER;
    }
  })
  .describe('SVG path data (M, L, H, V, C, S, Q, T, Z; no arcs). One M at the start, and the path must be closed. Q and T are converted to C, which Canva needs.');

const formatting = z
  .strictObject({
    color: color.optional(),
    fontWeight: z.enum(['normal', 'thin', 'extralight', 'light', 'medium', 'semibold', 'bold', 'ultrabold', 'heavy']).optional(),
    fontStyle: z.enum(['normal', 'italic']).optional(),
    decoration: z.enum(['none', 'underline']).optional(),
    strikethrough: z.enum(['none', 'strikethrough']).optional(),
    link: z.string().optional().describe('URL to link the text to.'),
    fontSize: z.number().min(1).max(800).optional().describe('Paragraph-level: applies to whole paragraphs.'),
    textAlign: z.enum(['start', 'center', 'end', 'justify']).optional().describe('Paragraph-level.'),
    lineHeightEm: z.number().min(0.5).max(2.5).optional().describe('Paragraph-level.'),
    letterSpacingEm: z.number().min(-0.2).max(0.8).optional().describe('Paragraph-level.'),
    listLevel: z.number().int().min(0).max(5).optional().describe('Paragraph-level.'),
    listMarker: z.enum(['none', 'disc', 'circle', 'square', 'decimal', 'lower-alpha', 'lower-roman', 'checked', 'unchecked']).optional().describe('Paragraph-level.'),
  })
  .describe('Text formatting. Inline properties apply to the matched text; paragraph-level ones to every paragraph it touches.');

const target = {
  element: z.string().regex(/^\d+(\.\d+)?$/, 'Use an element path from read-page, like "3" or "3.1".').describe('Element path from read-page: "3", or "3.1" for the 2nd element inside group 3.'),
  key: z.string().optional().describe('The element\'s key from read-page. If the element changed since, the whole batch is rejected instead of editing the wrong thing.'),
};

const box = {
  top: z.number().describe('Pixels from the top of the page.'),
  left: z.number().describe('Pixels from the left of the page.'),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().min(-180).max(180).optional().describe('Degrees.'),
  transparency: z.number().min(0).max(1).optional().describe('0 = opaque, 1 = invisible.'),
};

const operation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set_text'), ...target, text: z.string().describe('The new text; "\\n" starts a new paragraph.'), formatting: formatting.optional() }).describe('Replace all text of a text element.'),
  z
    .strictObject({ op: z.literal('replace_text'), ...target, find: z.string().min(1), replace: z.string(), all: z.boolean().optional().describe('Replace every occurrence (default: the first).'), formatting: formatting.optional() })
    .describe('Replace part of a text element, keeping the formatting of the rest.'),
  z.strictObject({ op: z.literal('format_text'), ...target, find: z.string().min(1).optional().describe('Only format this text (every occurrence). Omit for the whole element.'), formatting }).describe('Format a text element or part of it.'),
  z
    .strictObject({
      op: z.literal('transform'),
      ...target,
      top: z.number().optional(),
      left: z.number().optional(),
      rotation: z.number().min(-180).max(180).optional(),
      transparency: z.number().min(0).max(1).optional(),
    })
    .describe(
      'Move, rotate or fade an element. Canva\'s API can\'t resize existing elements: for text change fontSize with format_text; for rectangles and shapes delete and insert a new one.',
    ),
  z
    .strictObject({ op: z.literal('set_fill'), ...target, color: color.nullable().describe('New fill color, or null to remove the color fill.'), pathIndex: z.number().int().min(0).optional().describe('Shapes: only this path (default: every path).') })
    .describe('Change the fill color of a rectangle or shape.'),
  z.strictObject({ op: z.literal('set_stroke'), ...target, color: color.optional(), weight: z.number().min(0).max(100).optional() }).describe('Change the outline of a rectangle or shape.'),
  z.strictObject({ op: z.literal('delete'), ...target }).describe('Delete a top-level element.'),
  z.strictObject({ op: z.literal('reorder'), ...target, to: z.enum(['front', 'back', 'forward', 'backward']) }).describe('Change stacking order of a top-level element.'),
  z.strictObject({ op: z.literal('group'), elements: z.array(target.element).min(2).describe('Top-level element paths to group.') }).describe('Group top-level elements.'),
  z.strictObject({ op: z.literal('ungroup'), ...target }).describe('Ungroup a group.'),
  z.strictObject({ op: z.literal('set_background'), color }).describe('Set the page background color.'),
  z
    .strictObject({
      op: z.literal('insert_text'),
      text: z.string().min(1),
      top: box.top,
      left: box.left,
      width: box.width,
      rotation: box.rotation,
      transparency: box.transparency,
      formatting: formatting.optional(),
    })
    .describe('Add a text element on top of the page.'),
  z.strictObject({ op: z.literal('insert_rect'), ...box, color: color.optional(), strokeColor: color.optional(), strokeWeight: z.number().min(0).max(100).optional() }).describe('Add a rectangle.'),
  z
    .strictObject({
      op: z.literal('insert_shape'),
      ...box,
      viewBox: z.strictObject({ top: z.number(), left: z.number(), width: z.number().positive(), height: z.number().positive() }).describe('The coordinate box the path data is drawn in.'),
      paths: z
        .array(z.strictObject({ d: pathData, color: color.optional(), strokeColor: color.optional(), strokeWeight: z.number().min(0).max(100).optional() }))
        .min(1)
        .max(30)
        // Canva checks these only when it saves, so check them here to make dry runs fail the same way.
        .superRefine((paths, ctx) => {
          const size = paths.reduce((n, p) => n + new TextEncoder().encode(p.d).length, 0);
          if (size > 2048) ctx.addIssue({ code: 'custom', message: `Canva allows at most 2 KB of path data per shape; these paths have ${size} bytes. Split the shape or simplify the paths.` });
          const colors = new Set(paths.flatMap((p) => (p.color ? [p.color] : [])));
          if (colors.size > 6) ctx.addIssue({ code: 'custom', message: `Canva allows at most 6 different fill colors per shape; these paths use ${colors.size}. Split the shape.` });
        })
        .describe('1 to 30 paths, at most 2 KB of path data and 6 different fill colors in total.'),
    })
    .describe('Add a vector shape from SVG path data.'),
  z.strictObject({ op: z.literal('insert_embed'), ...box, url: z.string().url().describe('A YouTube or other oEmbed-supported URL.') }).describe('Add an embed (video, etc.).'),
  z
    .strictObject({
      op: z.literal('insert_image'),
      ...box,
      file: z.string().min(1).optional().describe('Absolute path of a local PNG, JPEG, WebP, SVG, HEIC or TIFF image (at most about 7.5 MB).'),
      url: z.string().min(1).optional().describe('Instead of file: a public https:// image URL ending in the image\'s extension, or a data: URL.'),
      name: z.string().min(1).max(255).optional().describe('Name for the image in the user\'s Canva uploads (default: the file name).'),
      radius: z.number().min(0).optional().describe('Corner radius in pixels; the image then fills a rounded frame.'),
    })
    .describe(
      'Add an image as its own element: it is uploaded to the user\'s Canva uploads, then placed in the box, cropped to fill it ' +
        '(give the box the image\'s aspect ratio to avoid cropping). Give exactly one of file or url. Needs the bridge app\'s upload permission.',
    ),
]);

const IMAGE_TYPES: Record<string, ImageMimeType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};
/** Canva's limit for an uploaded data URL, in characters. */
const MAX_DATA_URL = 10 * 1024 * 1024;

type ToolOperation = z.infer<typeof operation>;

/** insert_image takes a local file or URL; the app needs a data URL (or https URL) and its MIME type. */
async function resolveImage(op: ToolOperation, index: number): Promise<EditOperation> {
  if (op.op !== 'insert_image') return op as EditOperation;
  const { file, url, ...rest } = op;
  const fail = (why: string) => new Error(`Operation ${index + 1} (insert_image): ${why}`);
  if (!file === !url) throw fail('give exactly one of file or url.');
  let source: string;
  let mimeType: ImageMimeType | undefined;
  if (file) {
    mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mimeType) throw fail(`${path.basename(file)} isn't a PNG, JPEG, WebP, SVG, HEIC or TIFF file.`);
    const bytes = await fs.readFile(file).catch((err) => {
      throw fail(`can't read ${file}: ${errorMessage(err)}`);
    });
    source = `data:${mimeType};base64,${bytes.toString('base64')}`;
  } else if (url!.startsWith('data:')) {
    const type = /^data:([^;,]+);base64,/.exec(url!)?.[1];
    mimeType = Object.values(IMAGE_TYPES).find((t) => t === type);
    if (!mimeType) throw fail('the data URL must be base64-encoded PNG, JPEG, WebP, SVG, HEIC or TIFF.');
    source = url!;
  } else {
    if (!url!.startsWith('https://')) throw fail('Canva only fetches https:// image URLs.');
    mimeType = IMAGE_TYPES[path.extname(new URL(url!).pathname).toLowerCase()];
    if (!mimeType) throw fail('the URL must end in the image\'s file extension (.png, .jpg, .webp, .svg...).');
    source = url!;
  }
  if (source.startsWith('data:') && source.length > MAX_DATA_URL) {
    throw fail(`the image is ${(source.length / 1024 / 1024).toFixed(1)} MB as a data URL; Canva accepts at most 10 MB. Use a smaller or compressed image.`);
  }
  return { ...rest, url: source, mimeType, name: rest.name ?? (file ? path.basename(file) : undefined) };
}

export function registerEditorTools(server: McpServer, deps: ToolDeps) {
  const n = (base: Parameters<typeof toolName>[1]) => toolName(deps.config.toolPrefix, base);
  const bridge = deps.bridge;
  const timeout = deps.config.bridge.timeoutMs;
  const requireBridge = () => {
    if (!bridge) throw new Error('The editing bridge isn\'t running in this server (CANVA_BRIDGE=off).');
    return bridge;
  };

  server.registerTool(
    n('editor-status'),
    {
      title: 'Editor status',
      description:
        'Shows whether a Canva editor is connected through the canva-mcp bridge app, which design and page it has open (with the design ID for the REST tools), ' +
        `and the list of pages. Call this before ${n('read-page')}/${n('edit-page')}, or when they fail.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async () => {
      const b = requireBridge();
      const status = await b.status();
      let design: DesignContext | { error: string } | undefined;
      if (status.mode !== 'unavailable' && status.apps.some((a) => a.current)) {
        design = await b.request<DesignContext>('get_context', undefined, timeout).catch((err) => ({ error: errorMessage(err) }));
      }
      const next =
        status.mode === 'unavailable'
          ? status.problem
          : !status.apps.length && status.tlsRejected
            ? `No editor connected, and the browser rejected the bridge's local certificate ${status.tlsRejected.count} time(s). Ask the user to open https://localhost:${deps.config.bridge.tlsPort} once and accept it (Advanced -> Continue), then return to Canva.`
            : !status.apps.length
              ? 'No editor connected. Ask the user to open the design in Chrome or Edge and open the "canva-mcp bridge" app (Apps panel, or Preview in the Developer Portal).'
            : status.apps.every((a) => a.outdated)
              ? 'The connected app is an older version: ask the user to click the reload icon at the top of the app panel.'
              : undefined;
      return { content: [json({ bridge: status, design, next })] };
    }),
  );

  server.registerTool(
    n('read-page'),
    {
      title: 'Read page',
      description:
        'Reads the elements of a page in the design open in the connected Canva editor: text (with optional formatting), rectangles, shapes, groups and embeds, ' +
        'with their position, size, rotation, colors and lock state, plus the page size and background. ' +
        `Each element has a path (its address for ${n('edit-page')}) and a key (pass it back so edits fail safely if the element changed). ` +
        'Images show up as rectangles or shapes with a media fill. Docs and whiteboards are reported as unsupported pages.',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('1-based page number. Omit for the page open in the editor.'),
        formatting: z.boolean().optional().describe('Include per-run text formatting (weight, size, color...). Off by default to keep results short.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async (args) => {
      const content = await requireBridge().request<PageContent>('read_page', { page: args.page, formatting: args.formatting }, timeout);
      return { content: [json(content)] };
    }),
  );

  server.registerTool(
    n('edit-page'),
    {
      title: 'Edit page',
      description:
        'Edits a page of the design open in the connected Canva editor with a batch of operations: change or format text, move/rotate/fade, recolor fills and outlines, ' +
        'set the background, reorder, delete, group/ungroup, and insert text, rectangles, shapes, images or embeds. ' +
        `Address elements by the path from ${n('read-page')} and pass its key. Paths refer to the page as it was before this batch, so elements inserted here can't be targeted until the next read. ` +
        'The batch is all-or-nothing: if any operation fails, nothing is saved. Use dryRun to check a batch first. ' +
        'Changes appear in the user\'s editor immediately and can be undone there with Ctrl+Z. Locked elements and pages can\'t be edited.',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('1-based page number. Omit for the page open in the editor.'),
        operations: z.array(operation).min(1).max(100),
        dryRun: z.boolean().optional().describe('Apply the operations in a scratch session and return the result without saving.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guarded(async (args) => {
      const operations = await Promise.all(args.operations.map(resolveImage));
      // Uploads happen before the page opens and can take a while each.
      const uploads = operations.filter((o) => o.op === 'insert_image').length;
      const result = await requireBridge()
        .request<EditPageResult>('edit_page', { ...args, operations }, Math.max(timeout, 45_000 + (args.dryRun ? 0 : uploads * 30_000)))
        .catch((err) => {
          // Bridge apps built before the fix save while the page is still open, which Canva refuses.
          if (/a page is open/i.test(errorMessage(err))) {
            throw new Error(
              `${errorMessage(err)} The bridge app running in Canva is an old build that can only save the page on screen. ` +
                'If it is an uploaded bundle (it connects over wss://), upload bridge-app/dist/app.js again in the Developer Portal; with a Development URL, reload the app panel. ' +
                'Until then, leave out page to edit the page open in the editor.',
            );
          }
          throw err;
        });
      // Apps built before insert_image skip operations they don't know without a word.
      if (result.applied.some((a) => a.op === 'insert_image' && !a.detail)) {
        throw new Error(
          'The bridge app running in Canva is an old build without insert_image, so no image was placed (other operations in the batch were saved). ' +
            'Upload bridge-app/dist/app.js again in the Developer Portal (or reload the panel when using the Development URL), reload the Canva tab, and reopen the app.',
        );
      }
      return { content: [json(result)] };
    }),
  );
}
