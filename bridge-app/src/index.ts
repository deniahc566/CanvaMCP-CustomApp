import { upload } from '@canva/asset';
import { getDesignMetadata, getDesignToken, openDesign } from '@canva/design';
import { prepareDesignEditor } from '@canva/intents/design';
import { requestOpenExternalUrl } from '@canva/platform';
import { CERT_PAGE, connectBridge } from './connection.js';
import { createHandlers } from './editor.js';

const RETRY_MS = 3000;

const STYLE = `
  :root { color-scheme: light dark; --fg: #0e1318; --muted: #5f6b7a; --ok: #0a7d3a; --bad: #c0362c; --line: #d9dde3; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f0f2f5; --muted: #a5adba; --ok: #4cc27c; --bad: #ff7a6e; --line: #3a3f47; } }
  body { margin: 0; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: transparent; }
  .wrap { padding: 12px; display: grid; gap: 12px; }
  h1 { font-size: 15px; margin: 0; }
  .status { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); }
  .status.ok { border-color: var(--ok); }
  .status.bad { border-color: var(--bad); }
  .muted { color: var(--muted); font-size: 12px; }
  button { font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; justify-self: start; }
  ol { margin: 0; padding-left: 18px; }
  code { font-size: 12px; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function render(root: HTMLElement) {
  document.head.append(el('style', { textContent: STYLE }));
  const status = el('div', { className: 'status' }, 'Looking for canva-mcp…');
  const details = el('div', { className: 'muted' });
  const origin = el('div', { className: 'muted' }, 'App origin: ', el('code', { textContent: location.origin }));
  const log = el('ol', { className: 'muted' });
  const retry = el('button', { textContent: 'Retry now' });
  root.append(
    el(
      'div',
      { className: 'wrap' },
      el('h1', { textContent: 'canva-mcp bridge' }),
      status,
      details,
      retry,
      origin,
      el('div', {}, el('div', { className: 'muted', textContent: 'Recent requests from canva-mcp' }), log),
    ),
  );

  const handlers = createHandlers({ openDesign, getDesignMetadata, getDesignToken, upload });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connecting = false;
  let connected = false;

  const setStatus = (kind: 'ok' | 'bad' | '', text: string) => {
    status.className = `status ${kind}`;
    status.textContent = text;
  };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void attempt(), ms);
  };

  const attempt = async () => {
    if (connecting || connected) return;
    connecting = true;
    clearTimeout(timer);
    const result = await connectBridge(handlers, {
      onRequest: (method, ok, ms, error) => {
        log.prepend(el('li', { textContent: `${new Date().toLocaleTimeString()}  ${method}  ${ok ? `ok, ${ms} ms` : `failed: ${error}`}` }));
        while (log.childElementCount > 15) log.lastElementChild?.remove();
      },
      onClose: () => {
        connected = false;
        setStatus('bad', 'canva-mcp went away. Reconnecting…');
        schedule(1000);
      },
    });
    connecting = false;
    if (result.ok) {
      connected = true;
      setStatus('ok', 'Connected. Claude can read and edit the page you have open.');
      details.replaceChildren(el('code', { textContent: result.url }));
      return;
    }
    setStatus('bad', 'Waiting for canva-mcp. It starts with Claude; this panel keeps retrying.');
    // An app uploaded to the Developer Portal runs under Canva's strict policy, which blocks ws:// and
    // leaves only wss://, whose self-signed certificate the browser has to accept once per session.
    const wsBlocked = result.attempts.some((a) => a.url.startsWith('ws:') && a.error.includes('Content Security Policy'));
    const cert = el('button', { textContent: 'Open certificate page' });
    cert.onclick = () => void requestOpenExternalUrl({ url: CERT_PAGE });
    details.replaceChildren(
      el('ol', {}, ...result.attempts.map((a) => el('li', {}, el('code', { textContent: a.url }), ` ${a.error}`))),
      wsBlocked
        ? el(
            'div',
            {},
            'This copy of the app can only connect over wss. If Claude is running, the browser probably needs to accept canva-mcp\'s local certificate: ',
            'open the page, choose Advanced → Continue, then come back.',
          )
        : el('div', {}, 'If Chrome or Edge asked to let Canva access apps on this device, allow it.'),
      cert,
    );
    schedule(RETRY_MS);
  };

  retry.onclick = () => void attempt();
  void attempt();
}

prepareDesignEditor({
  render: () => render(document.getElementById('root') ?? document.body),
});
