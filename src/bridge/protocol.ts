// Messages between canva-mcp and the Canva bridge app (bridge-app/), sent as JSON over a WebSocket.
// The app imports this file too, so it must stay free of Node APIs.

export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * Fixed because the app is built with them: 3860 for the bridge socket, 3861 for the optional wss
 * listener, 8080 for the app bundle (the Development URL in the Developer Portal).
 */
export const BRIDGE_PORTS = { ws: 3860, wss: 3861, app: 8080 } as const;
export const BRIDGE_PATH = '/bridge';
/** Where a second canva-mcp instance connects to borrow the first one's app connection. */
export const RELAY_PATH = '/relay';

export interface CspViolation {
  directive: string;
  blockedURI: string;
}

/** First message the app sends on every connection. */
export interface HelloMessage {
  type: 'hello';
  protocol: number;
  /** The URL this connection was opened to, e.g. ws://localhost:3860/bridge. */
  url: string;
  /** location.origin of the app iframe, as the app sees it. */
  appOrigin: string;
  userAgent: string;
  cspViolations: CspViolation[];
}

export type BridgeMethod = 'ping' | 'get_context' | 'read_page' | 'edit_page';

export interface RequestMessage {
  type: 'request';
  id: number;
  method: BridgeMethod;
  params?: unknown;
}

export interface ResponseMessage {
  type: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type AppMessage = HelloMessage | ResponseMessage;

// --- Design data ---------------------------------------------------------------------------------

export interface PageInfo {
  /** 1-based page number. */
  number: number;
  id?: string;
  title?: string;
  type: string;
  width?: number;
  height?: number;
}

export interface DesignContext {
  title?: string;
  /** The design's ID (same as in canva.com/design/<id>), read from the app's design token. */
  designId?: string;
  pages: PageInfo[];
  /** The page open in the editor, when it could be matched to the page list. */
  currentPage?: number;
}

export interface Formatting {
  color?: string;
  fontWeight?: 'normal' | 'thin' | 'extralight' | 'light' | 'medium' | 'semibold' | 'bold' | 'ultrabold' | 'heavy';
  fontStyle?: 'normal' | 'italic';
  decoration?: 'none' | 'underline';
  strikethrough?: 'none' | 'strikethrough';
  link?: string;
  fontSize?: number;
  textAlign?: 'start' | 'center' | 'end' | 'justify';
  lineHeightEm?: number;
  letterSpacingEm?: number;
  listLevel?: number;
  listMarker?: 'none' | 'disc' | 'circle' | 'square' | 'decimal' | 'lower-alpha' | 'lower-roman' | 'checked' | 'unchecked';
}

export interface FillInfo {
  color?: string;
  /** Set when the fill is an image or video; existing media can't be swapped through the bridge (insert_image adds new images). */
  media?: 'image' | 'video';
}

export interface ElementInfo {
  /** Address for edit operations: "3" is the 4th top-level element, "3.1" the 2nd element inside that group. */
  path: string;
  /** Fingerprint of the element as read; pass it back with an edit to make sure it hasn't changed since. */
  key: string;
  type: 'rect' | 'shape' | 'group' | 'embed' | 'text' | 'unsupported';
  top: number;
  left: number;
  width: number;
  height: number;
  rotation: number;
  transparency: number;
  locked: boolean;
  text?: string;
  regions?: { text: string; formatting?: Partial<Formatting> }[];
  fill?: FillInfo;
  stroke?: { weight: number; color?: string };
  paths?: { fill?: FillInfo; stroke?: { weight: number; color?: string } }[];
  url?: string;
  children?: ElementInfo[];
}

export interface PageContent {
  page?: number;
  pageId?: string;
  pageType: string;
  locked?: boolean;
  dimensions?: { width: number; height: number };
  background?: FillInfo;
  elements: ElementInfo[];
}

export interface ReadPageParams {
  /** 1-based page number; omit for the page open in the editor. */
  page?: number;
  /** Include per-run formatting of text (font weight, size, color...). */
  formatting?: boolean;
}

// --- Edits ---------------------------------------------------------------------------------------

interface Target {
  /** Element path from read-page, e.g. "2" or "4.1". */
  element: string;
  /** The element's key from read-page. If given and the element changed since, the whole batch is rejected. */
  key?: string;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  rotation?: number;
  transparency?: number;
}

export type EditOperation =
  | (Target & { op: 'set_text'; text: string; formatting?: Formatting })
  | (Target & { op: 'replace_text'; find: string; replace: string; all?: boolean; formatting?: Formatting })
  | (Target & { op: 'format_text'; find?: string; formatting: Formatting })
  | (Target & { op: 'transform'; top?: number; left?: number; rotation?: number; transparency?: number })
  | (Target & { op: 'set_fill'; color: string | null; pathIndex?: number })
  | (Target & { op: 'set_stroke'; color?: string; weight?: number })
  | (Target & { op: 'delete' })
  | (Target & { op: 'reorder'; to: 'front' | 'back' | 'forward' | 'backward' })
  | { op: 'ungroup'; element: string; key?: string }
  | { op: 'group'; elements: string[] }
  | { op: 'set_background'; color: string }
  | ({ op: 'insert_text'; text: string; top: number; left: number; width: number; rotation?: number; transparency?: number; formatting?: Formatting })
  | (Box & { op: 'insert_rect'; color?: string; strokeColor?: string; strokeWeight?: number })
  | (Box & {
      op: 'insert_shape';
      viewBox: { top: number; left: number; width: number; height: number };
      paths: { d: string; color?: string; strokeColor?: string; strokeWeight?: number }[];
    })
  | (Box & { op: 'insert_embed'; url: string })
  | (Box & {
      op: 'insert_image';
      /** A data URL (canva-mcp turns local files into one) or a public https URL; the app uploads it to the user's media library. */
      url: string;
      mimeType: ImageMimeType;
      /** Name shown in the user's media library. */
      name?: string;
      /** Corner radius in page pixels; when set, the image fills a rounded-rectangle shape instead of a rectangle. */
      radius?: number;
    });

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml' | 'image/heic' | 'image/tiff';

export interface EditPageParams {
  page?: number;
  operations: EditOperation[];
  /** Run the operations and report the result without saving anything to the design. */
  dryRun?: boolean;
}

export interface EditPageResult {
  page?: number;
  saved: boolean;
  applied: { op: string; element?: string; detail?: string }[];
  /** The page after the edits, with fresh paths and keys. */
  content: PageContent;
}
