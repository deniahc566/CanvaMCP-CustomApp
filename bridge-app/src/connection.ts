import {
  BRIDGE_PATH,
  BRIDGE_PORTS,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMethod,
  type CspViolation,
  type HelloMessage,
  type RequestMessage,
  type ResponseMessage,
} from '../../src/bridge/protocol.js';

/** Tried in order: plain ws (allowed for apps in development), then wss for canva-mcp's optional TLS listener. */
export const ENDPOINTS = [
  `ws://localhost:${BRIDGE_PORTS.ws}${BRIDGE_PATH}`,
  `ws://127.0.0.1:${BRIDGE_PORTS.ws}${BRIDGE_PATH}`,
  `wss://localhost:${BRIDGE_PORTS.wss}${BRIDGE_PATH}`,
];

/** Opening this once lets the browser accept the wss listener's self-signed certificate. */
export const CERT_PAGE = `https://localhost:${BRIDGE_PORTS.wss}/`;

const CONNECT_TIMEOUT_MS = 3000;

const violations: CspViolation[] = [];
document.addEventListener('securitypolicyviolation', (e) => {
  const v = { directive: e.effectiveDirective || e.violatedDirective, blockedURI: e.blockedURI };
  // The panel retries every few seconds; keep each blocked address once.
  if (!violations.some((seen) => seen.directive === v.directive && seen.blockedURI === v.blockedURI)) violations.push(v);
});

export function cspViolations(): CspViolation[] {
  return [...violations];
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out'));
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      const host = new URL(url).host;
      const csp = violations.find((v) => v.blockedURI.includes(host));
      reject(new Error(csp ? `blocked by Content Security Policy (${csp.directive})` : 'not reachable'));
    };
  });
}

export type Handlers = Record<BridgeMethod, (params: unknown) => Promise<unknown>>;

export interface BridgeEvents {
  onRequest?: (method: string, ok: boolean, ms: number, error?: string) => void;
  onClose?: () => void;
}

export type ConnectResult = { ok: true; url: string; close: () => void } | { ok: false; attempts: { url: string; error: string }[] };

/** Connect to canva-mcp over the first endpoint that answers, then serve its requests until the socket closes. */
export async function connectBridge(handlers: Handlers, events: BridgeEvents = {}): Promise<ConnectResult> {
  const attempts: { url: string; error: string }[] = [];
  for (const url of ENDPOINTS) {
    let ws: WebSocket;
    try {
      ws = await openSocket(url);
    } catch (err) {
      attempts.push({ url, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const hello: HelloMessage = {
      type: 'hello',
      protocol: BRIDGE_PROTOCOL_VERSION,
      url,
      appOrigin: location.origin,
      userAgent: navigator.userAgent,
      cspViolations: cspViolations(),
    };
    ws.send(JSON.stringify(hello));
    ws.onmessage = async (event) => {
      let msg: RequestMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type !== 'request') return;
      const started = performance.now();
      const handler = handlers[msg.method];
      let reply: ResponseMessage;
      try {
        if (!handler) throw new Error(`This version of the bridge app doesn't support "${msg.method}". Reload the app panel.`);
        reply = { type: 'response', id: msg.id, ok: true, result: await handler(msg.params) };
      } catch (err) {
        reply = { type: 'response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      events.onRequest?.(msg.method, reply.ok, Math.round(performance.now() - started), reply.error);
    };
    ws.onclose = () => events.onClose?.();
    return { ok: true, url, close: () => ws.close() };
  }
  return { ok: false, attempts };
}
