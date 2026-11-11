// Live check of the editing bridge against a real Canva editor: starts canva-mcp the way Claude does
// (stdio), waits for the bridge app to connect, reads the open page and, with --edit, runs a few
// edits on it, including two that must leave the design untouched (a dry run and a failing batch).
//
//   node scripts/try-bridge.mjs [--edit] [--wait 300]
//
// --edit changes the page open in the editor: use a throwaway design.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const edit = process.argv.includes('--edit');
const waitArg = process.argv.indexOf('--wait');
const waitMs = (waitArg > -1 ? Number(process.argv[waitArg + 1]) : 300) * 1000;
const out = (line = '') => process.stdout.write(`${line}\n`);

const client = new Client({ name: 'try-bridge', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'index.js')], env: { ...process.env }, stderr: 'inherit' }),
);

async function call(name, args = {}) {
  const started = performance.now();
  const res = await client.callTool({ name: `canva_local_${name}`, arguments: args });
  const ms = Math.round(performance.now() - started);
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { error: res.isError ? text : undefined, data, ms };
}

const summarize = (content) =>
  content.elements.map((e) => `    ${e.path.padEnd(4)} ${e.type.padEnd(6)} (${e.left}, ${e.top}) ${e.width}x${e.height}${e.text !== undefined ? ` "${e.text.replace(/\s+/g, ' ').slice(0, 40)}"` : ''}${e.fill?.color ? ` fill ${e.fill.color}` : ''}${e.locked ? ' [locked]' : ''}`);

try {
  out(`Waiting up to ${waitMs / 1000}s for the canva-mcp bridge app to connect (reload its panel in Canva)...`);
  const deadline = Date.now() + waitMs;
  let status;
  let said = '';
  for (;;) {
    status = (await call('editor-status')).data;
    const note = status?.next ?? '';
    if (note && note !== said) out(`  ${note}`);
    said = note;
    if (status?.design && !status.design.error) break;
    if (Date.now() > deadline) throw new Error('No editor connected in time.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  const b = status.bridge;
  out(`\nConnected. Bridge mode ${b.mode}, pinned origin ${b.originPinned ?? '(none)'}, app bundle ${b.appBundle.served ? b.appBundle.url : b.appBundle.problem}`);
  out(`Design "${status.design.title ?? '(untitled)'}" id ${status.design.designId ?? '?'}, ${status.design.pages.length} page(s), current page ${status.design.currentPage ?? '?'}`);
  for (const app of b.apps) {
    out(`App connected over ${app.url} from ${app.origin}${app.cspViolations.length ? `; blocked first: ${app.cspViolations.map((v) => `${v.blockedURI} (${v.directive})`).join(', ')}` : '; no CSP violations'}`);
  }

  const read = await call('read-page', { formatting: true });
  if (read.error) throw new Error(read.error);
  out(`\nread-page (${read.ms} ms): ${read.data.pageType} ${read.data.dimensions?.width}x${read.data.dimensions?.height}, background ${JSON.stringify(read.data.background)}`);
  for (const line of summarize(read.data)) out(line);

  if (edit) {
    const page = read.data;
    const W = page.dimensions?.width ?? 1920;
    const text = page.elements.find((e) => e.type === 'text' && !e.locked);
    const ops = [
      { op: 'set_background', color: '#f4f0ff' },
      { op: 'insert_rect', top: 120, left: 80, width: W - 160, height: 300, color: '#ffffff', strokeColor: '#8b3dff', strokeWeight: 4 },
      { op: 'insert_text', text: 'Edited by canva-mcp', top: 160, left: 120, width: 1000, formatting: { fontSize: 72, fontWeight: 'bold', color: '#3b1a7a' } },
      { op: 'insert_shape', top: 160, left: W - 380, width: 220, height: 220, viewBox: { top: 0, left: 0, width: 100, height: 100 }, paths: [{ d: 'M50 0 L100 100 L0 100 Z', color: '#ff6b6b' }] },
    ];
    if (text) ops.push({ op: 'set_text', element: text.path, key: text.key, text: 'Hello from canva-mcp', formatting: { color: '#8b3dff' } });
    const first = await call('edit-page', { operations: ops });
    if (first.error) throw new Error(first.error);
    out(`\nedit-page batch 1 (${first.ms} ms): ${first.data.applied.map((a) => `${a.op}: ${a.detail}`).join(' | ')}`);
    for (const line of summarize(first.data.content)) out(line);

    const after = first.data.content.elements;
    const card = after.find((e) => e.type === 'rect' && e.fill?.color === '#ffffff');
    const shape = after.find((e) => e.type === 'shape');
    const heading = after.find((e) => e.text === 'Edited by canva-mcp');
    const second = await call('edit-page', {
      operations: [
        { op: 'reorder', element: card.path, key: card.key, to: 'back' },
        { op: 'transform', element: shape.path, key: shape.key, rotation: 20 },
        { op: 'format_text', element: heading.path, key: heading.key, find: 'canva-mcp', formatting: { color: '#ff6b6b', decoration: 'underline' } },
      ],
    });
    out(`\nedit-page batch 2 (${second.ms} ms): ${second.error ?? second.data.applied.map((a) => `${a.op}: ${a.detail}`).join(' | ')}`);

    const beforeChecks = (await call('read-page')).data;
    const dry = await call('edit-page', { dryRun: true, operations: [{ op: 'set_background', color: '#000000' }, ...beforeChecks.elements.filter((e) => !e.locked).map((e) => ({ op: 'delete', element: e.path }))] });
    const failing = await call('edit-page', {
      operations: [
        { op: 'set_background', color: '#ff0000' },
        { op: 'replace_text', element: beforeChecks.elements.find((e) => e.type === 'text').path, find: 'this text is not there', replace: 'x' },
      ],
    });
    const stale = await call('edit-page', { operations: [{ op: 'delete', element: '0', key: '00000000' }] });
    const check = (await call('read-page')).data;
    const same = JSON.stringify(check.elements.map((e) => e.key)) === JSON.stringify(beforeChecks.elements.map((e) => e.key)) && check.background?.color === beforeChecks.background?.color;
    out(`\ndry run: saved=${dry.data?.saved} (${dry.error ?? 'ok'})`);
    out(`failing batch: ${failing.error ? failing.error.slice(0, 160) : 'unexpectedly succeeded'}`);
    out(`stale key: ${stale.error ? stale.error.slice(0, 120) : 'unexpectedly succeeded'}`);
    out(`page unchanged by the dry run and both rejected batches: ${same ? 'YES' : 'NO'} (background ${check.background?.color})`);
    for (const line of summarize(check)) out(line);
  }
  out('\nDone.');
} catch (err) {
  out(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
