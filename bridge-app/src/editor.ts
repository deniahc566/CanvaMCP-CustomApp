import type { ImageRef, upload } from '@canva/asset';
import type { DesignEditing, getDesignMetadata, getDesignToken, InlineFormatting, openDesign, RichtextFormatting, RichtextRange } from '@canva/design';
import type {
  BridgeMethod,
  DesignContext,
  EditOperation,
  EditPageParams,
  EditPageResult,
  ElementInfo,
  FillInfo,
  Formatting,
  PageContent,
  ReadPageParams,
} from '../../src/bridge/protocol.js';

/** The parts of @canva/design the handlers use; tests pass a fake editor instead. */
export interface EditorSdk {
  openDesign: typeof openDesign;
  getDesignMetadata: typeof getDesignMetadata;
  getDesignToken: typeof getDesignToken;
  /** From @canva/asset; needs the canva:asset:private:write permission. Without it, insert_image is refused. */
  upload?: typeof upload;
}

type Handler = (params: unknown) => Promise<unknown>;
type Element = DesignEditing.AbsoluteElement | DesignEditing.GroupContentElement;
type Page = DesignEditing.Page;
type Helpers = DesignEditing.PageHelpers;
type Bounds = { index: number; length: number };

const round = (n: number) => Math.round(n * 10) / 10;

/** FNV-1a: a short, synchronous fingerprint (the browser's crypto digests are async). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Canva text always ends in a paragraph break; leave it out of what the model sees and edits. */
function plain(text: RichtextRange): string {
  return text.readPlaintext().replace(/\n$/, '');
}

function keyOf(el: Element): string {
  const text = el.type === 'text' ? plain(el.text) : '';
  return fnv([el.type, round(el.top), round(el.left), round(el.width), round(el.height), round(el.rotation), text].join('|'));
}

function fillInfo(fill: { colorContainer: { ref: DesignEditing.ColorFill | undefined }; mediaContainer: { ref: DesignEditing.MediaFill | undefined } } | undefined): FillInfo | undefined {
  if (!fill) return undefined;
  const color = fill.colorContainer.ref;
  const media = fill.mediaContainer.ref;
  const info: FillInfo = {};
  if (color?.type === 'solid') info.color = color.color;
  if (media) info.media = media.type;
  return info.color || info.media ? info : undefined;
}

function strokeInfo(stroke: DesignEditing.Stroke | undefined) {
  if (!stroke) return undefined;
  const color = stroke.colorContainer.ref;
  return { weight: stroke.weight, color: color?.type === 'solid' ? color.color : undefined };
}

function describe(el: Element, path: string, formatting: boolean): ElementInfo {
  const info: ElementInfo = {
    path,
    key: keyOf(el),
    type: el.type,
    top: round(el.top),
    left: round(el.left),
    width: round(el.width),
    height: round(el.height),
    rotation: round(el.rotation),
    transparency: el.transparency,
    locked: el.locked,
  };
  switch (el.type) {
    case 'text':
      info.text = plain(el.text);
      if (formatting) info.regions = el.text.readTextRegions().filter((r) => r.text !== '\n');
      break;
    case 'rect':
      info.fill = fillInfo(el.fill);
      info.stroke = strokeInfo(el.stroke);
      break;
    case 'shape':
      info.paths = el.paths.toArray().map((p) => ({ fill: fillInfo(p.fill), stroke: strokeInfo(p.stroke) }));
      break;
    case 'group':
      info.children = el.contents.toArray().map((child, i) => describe(child, `${path}.${i}`, formatting));
      break;
    case 'embed':
      info.url = el.url;
      break;
  }
  return info;
}

function describePage(page: Page, number: number | undefined, formatting: boolean): PageContent {
  if (page.type !== 'absolute') return { page: number, pageType: page.type, elements: [] };
  return {
    page: number,
    pageId: page.id,
    pageType: page.type,
    locked: page.locked,
    dimensions: page.dimensions && { width: page.dimensions.width, height: page.dimensions.height },
    background: fillInfo(page.background),
    elements: page.elements.toArray().map((el, i) => describe(el, String(i), formatting)),
  };
}

function elementAt(page: DesignEditing.AbsolutePage, path: string): Element | undefined {
  const [top, child] = path.split('.').map(Number);
  const el = page.elements.toArray()[top];
  if (child === undefined) return el;
  return el?.type === 'group' ? el.contents.toArray()[child] : undefined;
}

const INLINE_KEYS = ['color', 'fontWeight', 'fontStyle', 'decoration', 'strikethrough', 'link'] as const;

function split(formatting: Formatting | undefined) {
  if (!formatting) return { inline: undefined, paragraph: undefined };
  const inline: Record<string, unknown> = {};
  const paragraph: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(formatting)) {
    if (v === undefined) continue;
    ((INLINE_KEYS as readonly string[]).includes(k) ? inline : paragraph)[k] = v;
  }
  return {
    inline: Object.keys(inline).length ? (inline as InlineFormatting) : undefined,
    paragraph: Object.keys(paragraph).length ? (paragraph as RichtextFormatting) : undefined,
  };
}

function occurrences(haystack: string, needle: string, all: boolean): Bounds[] {
  const found: Bounds[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    found.push({ index: i, length: needle.length });
    if (!all) break;
  }
  return found;
}

const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 57)}...` : s}"`;

/**
 * Run `fn` on a page (the editor's current page, or a 1-based page number) inside one editing session,
 * saving its changes when it asks to. Canva refuses to sync while a page opened with openPage is still
 * open, so for a numbered page the save happens after openPage resolves.
 */
async function withPage<T>(sdk: EditorSdk, pageNumber: number | undefined, fn: (page: Page, helpers: Helpers) => Promise<{ value: T; save?: boolean }>): Promise<T> {
  let result: { value: T; save?: boolean } | undefined;
  if (pageNumber === undefined) {
    await sdk.openDesign({ type: 'current_page' }, async (session) => {
      result = await fn(session.page, session.helpers);
      if (result.save) await session.sync();
    });
  } else {
    await sdk.openDesign({ type: 'all_pages' }, async (session) => {
      const refs = session.pageRefs.toArray();
      if (pageNumber > refs.length) throw new Error(`Page ${pageNumber} doesn't exist; the design has ${refs.length} page${refs.length === 1 ? '' : 's'}.`);
      const opened = await session.helpers.openPage(refs[pageNumber - 1], async ({ page, helpers }) => {
        result = await fn(page, helpers);
      });
      if (opened.status === 'skipped') throw new Error(`Canva couldn't open page ${pageNumber}: ${opened.reason}`);
      if (result?.save) await session.sync();
    });
  }
  if (!result) throw new Error('The Canva editor ended the session without running it.');
  return result.value;
}

function unsupported(page: Page): Error {
  return new Error(`This page type ("${page.type}") can't be edited by apps. Canva Docs, whiteboards and some other formats aren't supported.`);
}

async function pageNumberOf(sdk: EditorSdk, id: string | undefined): Promise<number | undefined> {
  if (!id) return undefined;
  try {
    const pages = [...(await sdk.getDesignMetadata()).pageMetadata];
    const index = pages.findIndex((p) => p.type === 'absolute' && p.id === id);
    return index === -1 ? undefined : index + 1;
  } catch {
    return undefined;
  }
}

/** Rounded rectangle in a 0,0 → width,height box, as the M/L/C/Z path data Canva shapes take. */
function roundedRect(width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const k = r * 0.4477; // control-point inset for a quarter circle (1 - 0.5523)
  const f = (n: number) => String(Math.round(n * 100) / 100);
  return (
    `M${f(r)} 0 L${f(width - r)} 0 C${f(width - k)} 0 ${f(width)} ${f(k)} ${f(width)} ${f(r)} ` +
    `L${f(width)} ${f(height - r)} C${f(width)} ${f(height - k)} ${f(width - k)} ${f(height)} ${f(width - r)} ${f(height)} ` +
    `L${f(r)} ${f(height)} C${f(k)} ${f(height)} 0 ${f(height - k)} 0 ${f(height - r)} ` +
    `L0 ${f(r)} C0 ${f(k)} ${f(k)} 0 ${f(r)} 0 Z`
  );
}

function applyOne(op: EditOperation, page: DesignEditing.AbsolutePage, helpers: Helpers, target: Element | Element[] | undefined, imageRef?: ImageRef): Promise<string> | string {
  const el = target as Element;
  const needText = () => {
    if (el.type !== 'text') throw new Error(`${op.op} needs a text element, but the target is a ${el.type}.`);
    return el;
  };
  const topLevel = (path: string) => {
    if (path.includes('.')) throw new Error(`${op.op} only works on top-level elements, not on ${path} inside a group. Ungroup it first.`);
    return el as DesignEditing.AbsoluteElement;
  };
  const solid = (color: string) => ({ type: 'solid' as const, color });

  switch (op.op) {
    case 'set_text': {
      const text = needText().text;
      const before = plain(text);
      const { inline, paragraph } = split(op.formatting);
      const { bounds } = text.replaceText({ index: 0, length: before.length }, op.text, inline);
      if (paragraph) text.formatParagraph(bounds, paragraph);
      return `${quote(before)} -> ${quote(op.text)}`;
    }
    case 'replace_text': {
      const text = needText().text;
      const current = plain(text);
      const hits = occurrences(current, op.find, op.all ?? false);
      if (!hits.length) throw new Error(`${quote(op.find)} wasn't found in element ${op.element}, which says ${quote(current)}.`);
      const { inline, paragraph } = split(op.formatting);
      // Last to first, so earlier indexes stay valid.
      for (const hit of [...hits].reverse()) {
        const { bounds } = text.replaceText(hit, op.replace, inline);
        if (paragraph) text.formatParagraph(bounds, paragraph);
      }
      return `replaced ${hits.length} occurrence${hits.length === 1 ? '' : 's'}`;
    }
    case 'format_text': {
      const text = needText().text;
      const current = plain(text);
      const ranges = op.find ? occurrences(current, op.find, true) : [{ index: 0, length: current.length }];
      if (!ranges.length) throw new Error(`${quote(op.find!)} wasn't found in element ${op.element}, which says ${quote(current)}.`);
      const { inline, paragraph } = split(op.formatting);
      for (const range of ranges) {
        if (inline) text.formatText(range, inline);
        if (paragraph) text.formatParagraph(range, paragraph);
      }
      return `formatted ${ranges.length} range${ranges.length === 1 ? '' : 's'}`;
    }
    case 'transform': {
      if (el.type === 'unsupported') throw new Error('This element type is read-only for apps.');
      // Canva's editing API doesn't let apps resize existing elements (width/height are read-only).
      const editable = el;
      for (const prop of ['top', 'left', 'rotation', 'transparency'] as const) {
        if (op[prop] !== undefined) editable[prop] = op[prop]!;
      }
      return `now at (${round(editable.left)}, ${round(editable.top)}), rotation ${round(editable.rotation)}`;
    }
    case 'set_fill': {
      const state = op.color === null ? undefined : solid(op.color);
      if (el.type === 'rect') {
        el.fill.colorContainer.set(state);
        return el.fill.mediaContainer.ref ? 'color set (an image or video still covers it)' : 'fill set';
      }
      if (el.type === 'shape') {
        const paths = el.paths.toArray();
        const chosen = op.pathIndex === undefined ? paths : [paths[op.pathIndex]];
        if (chosen.some((p) => !p)) throw new Error(`The shape has ${paths.length} paths; pathIndex ${op.pathIndex} doesn't exist.`);
        for (const p of chosen) p.fill.colorContainer.set(state);
        return `fill set on ${chosen.length} path${chosen.length === 1 ? '' : 's'}`;
      }
      throw new Error(`set_fill works on rectangles and shapes, not ${el.type}. For text color use format_text.`);
    }
    case 'set_stroke': {
      const strokes = el.type === 'rect' ? [el.stroke] : el.type === 'shape' ? el.paths.toArray().flatMap((p) => (p.stroke ? [p.stroke] : [])) : [];
      if (!strokes.length) throw new Error(el.type === 'shape' ? 'This shape has no outline to change.' : `set_stroke works on rectangles and shapes, not ${el.type}.`);
      for (const s of strokes) {
        if (op.weight !== undefined) s.weight = op.weight;
        if (op.color) s.colorContainer.set(solid(op.color));
      }
      return 'outline set';
    }
    case 'delete':
      page.elements.delete(topLevel(op.element));
      return 'deleted';
    case 'reorder': {
      const item = topLevel(op.element);
      const list = page.elements.toArray();
      const at = list.indexOf(item);
      if (op.to === 'front') page.elements.moveBefore(undefined, item);
      else if (op.to === 'back') page.elements.moveAfter(undefined, item);
      else if (op.to === 'forward' && at < list.length - 1) page.elements.moveAfter(list[at + 1], item);
      else if (op.to === 'backward' && at > 0) page.elements.moveBefore(list[at - 1], item);
      return `moved ${op.to}`;
    }
    case 'group': {
      const items = target as Element[];
      if (op.elements.some((p) => p.includes('.'))) throw new Error('group only takes top-level elements.');
      return helpers
        .group({ elements: items as Exclude<DesignEditing.GroupContentElement, DesignEditing.UnsupportedElement>[] })
        .then(() => `grouped ${items.length} elements`);
    }
    case 'ungroup': {
      if (el.type !== 'group') throw new Error(`ungroup needs a group, but the target is a ${el.type}.`);
      return helpers.ungroup({ element: topLevel(op.element) as DesignEditing.GroupElement }).then((parts) => `ungrouped into ${parts.length} elements`);
    }
    case 'set_background':
      if (!page.background) throw new Error('This page has no background to set (whiteboards have none).');
      page.background.colorContainer.set(solid(op.color));
      return 'background set';
    case 'insert_text': {
      const state = helpers.elementStateBuilder.createTextElement({
        top: op.top,
        left: op.left,
        width: op.width,
        rotation: op.rotation,
        transparency: op.transparency,
        text: { regions: [{ text: op.text, formatting: op.formatting }] },
      });
      page.elements.insertBefore(undefined, state);
      return 'text added on top';
    }
    case 'insert_rect': {
      const state = helpers.elementStateBuilder.createRectElement({
        top: op.top,
        left: op.left,
        width: op.width,
        height: op.height,
        rotation: op.rotation,
        transparency: op.transparency,
        fill: { colorContainer: solid(op.color ?? '#d9d9d9') },
        stroke: op.strokeColor ? { weight: op.strokeWeight ?? 2, colorContainer: solid(op.strokeColor) } : undefined,
      });
      page.elements.insertBefore(undefined, state);
      return 'rectangle added on top';
    }
    case 'insert_shape': {
      const state = helpers.elementStateBuilder.createShapeElement({
        top: op.top,
        left: op.left,
        width: op.width,
        height: op.height,
        rotation: op.rotation,
        transparency: op.transparency,
        viewBox: op.viewBox,
        paths: op.paths.map((p) => ({
          d: p.d,
          fill: p.color ? { colorContainer: solid(p.color) } : undefined,
          stroke: p.strokeColor ? { weight: p.strokeWeight ?? 2, colorContainer: solid(p.strokeColor) } : undefined,
        })),
      });
      page.elements.insertBefore(undefined, state);
      return 'shape added on top';
    }
    case 'insert_embed': {
      const state = helpers.elementStateBuilder.createEmbedElement({
        top: op.top,
        left: op.left,
        width: op.width,
        height: op.height,
        rotation: op.rotation,
        transparency: op.transparency,
        url: op.url,
      });
      page.elements.insertBefore(undefined, state);
      return 'embed added on top';
    }
    case 'insert_image': {
      // A dry run doesn't upload, so it has no image to place; the rest of the batch is still checked.
      if (!imageRef) return 'image not placed (dry run: nothing uploaded)';
      const media = { type: 'image' as const, imageRef };
      const box = { top: op.top, left: op.left, width: op.width, height: op.height, rotation: op.rotation, transparency: op.transparency };
      const state = op.radius
        ? helpers.elementStateBuilder.createShapeElement({
            ...box,
            viewBox: { top: 0, left: 0, width: op.width, height: op.height },
            paths: [{ d: roundedRect(op.width, op.height, op.radius), fill: { mediaContainer: media, isMediaEditable: true } }],
          })
        : helpers.elementStateBuilder.createRectElement({ ...box, fill: { mediaContainer: media } });
      page.elements.insertBefore(undefined, state);
      return op.radius ? 'image added on top (rounded frame)' : 'image added on top';
    }
  }
}

/**
 * Uploads the images of a batch to the user's media library before the editing session opens, so a
 * slow upload doesn't hold the design open. Dry runs upload nothing.
 */
async function uploadImages(sdk: EditorSdk, operations: EditOperation[], dryRun: boolean): Promise<(ImageRef | undefined)[]> {
  const refs: (ImageRef | undefined)[] = [];
  for (const [i, op] of operations.entries()) {
    if (op.op !== 'insert_image' || dryRun) {
      refs.push(undefined);
      continue;
    }
    if (!sdk.upload) throw new Error('This build of the bridge app can\'t upload images. Rebuild it and reload the app panel.');
    try {
      const asset = await sdk.upload({ type: 'image', url: op.url, mimeType: op.mimeType, thumbnailUrl: op.url, aiDisclosure: 'none', name: op.name });
      await asset.whenUploaded();
      refs.push(asset.ref);
    } catch (err) {
      throw new Error(`Operation ${i + 1} (insert_image) couldn't upload the image, so nothing was changed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return refs;
}

/**
 * What the app does for each bridge request. The SDK is passed in so tests can supply a fake
 * editor; in Canva it is the real @canva/design.
 */
export function createHandlers(sdk: EditorSdk): Record<BridgeMethod, Handler> {
  return {
    ping: async () => ({ pong: true, at: Date.now() }),

    get_context: async (): Promise<DesignContext> => {
      const meta = await sdk.getDesignMetadata();
      const pages = [...meta.pageMetadata].map((p, i) => ({
        number: i + 1,
        type: p.type,
        id: p.type === 'absolute' ? p.id : undefined,
        title: p.type === 'absolute' ? p.title : undefined,
        width: p.type === 'absolute' ? p.dimensions?.width : undefined,
        height: p.type === 'absolute' ? p.dimensions?.height : undefined,
      }));
      let designId: string | undefined;
      try {
        // The design token is a JWT; its payload names the design. Only read here, never trusted for access.
        const payload = (await sdk.getDesignToken()).token.split('.')[1];
        designId = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).designId;
      } catch {
        // Not every editor context issues a token; the rest of the context is still useful.
      }
      let currentId: string | undefined;
      await sdk.openDesign({ type: 'current_page' }, async (session) => {
        if (session.page.type === 'absolute') currentId = session.page.id;
      });
      const current = pages.find((p) => p.id && p.id === currentId)?.number;
      return { title: meta.title, designId, pages, currentPage: current };
    },

    read_page: async (raw) => {
      const params = (raw ?? {}) as ReadPageParams;
      return withPage(sdk, params.page, async (page) => {
        const number = params.page ?? (await pageNumberOf(sdk, page.type === 'absolute' ? page.id : undefined));
        return { value: describePage(page, number, params.formatting ?? false) };
      });
    },

    edit_page: async (raw): Promise<EditPageResult> => {
      const params = raw as EditPageParams;
      if (!Array.isArray(params?.operations) || !params.operations.length) throw new Error('No operations given.');
      const imageRefs = await uploadImages(sdk, params.operations, params.dryRun ?? false);
      return withPage(sdk, params.page, async (page, helpers) => {
        if (page.type !== 'absolute') throw unsupported(page);
        if (page.locked) throw new Error('This page is locked. Unlock it in the editor first.');

        // Resolve every target against the page as it was read, before changing anything, so a
        // stale key or bad path rejects the whole batch.
        const resolve = (path: string, key?: string) => {
          const el = elementAt(page, path);
          if (!el) throw new Error(`There's no element at path ${path}. Read the page again.`);
          if (key && keyOf(el) !== key) throw new Error(`Element ${path} changed since it was read (key ${key} is now ${keyOf(el)}). Read the page again.`);
          if (el.locked) throw new Error(`Element ${path} is locked. Unlock it in the editor first.`);
          return el;
        };
        const targets = params.operations.map((op) => {
          if (op.op === 'group') return op.elements.map((p) => resolve(p));
          if ('element' in op) return resolve(op.element, op.key);
          return undefined;
        });

        const applied: EditPageResult['applied'] = [];
        for (const [i, op] of params.operations.entries()) {
          try {
            const detail = await applyOne(op, page, helpers, targets[i], imageRefs[i]);
            applied.push({ op: op.op, element: 'element' in op ? op.element : undefined, detail });
          } catch (err) {
            throw new Error(`Operation ${i + 1} (${op.op}${'element' in op ? ` on ${op.element}` : ''}) failed, so nothing was saved: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const number = params.page ?? (await pageNumberOf(sdk, page.id));
        return { value: { page: number, saved: !params.dryRun, applied, content: describePage(page, number, false) }, save: !params.dryRun };
      });
    },
  };
}
