import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebSocket } from 'ws';
import { createHandlers } from '../bridge-app/src/editor.ts';
import { convertSvg } from '../scripts/svg2canva.mjs';
import { ensureCert } from '../dist/bridge/cert.js';
import { BridgeHost } from '../dist/bridge/host.js';
import { appOriginAllowed } from '../dist/bridge/server.js';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';
import { createFakeEditor } from './fake-editor.mjs';
import { sampleSvg } from './svg-sample.mjs';

const APP_ORIGIN = 'https://app-aahogil51rk.canva-apps.com';
let tmp;

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function hostOptions(overrides = {}) {
  return {
    port: await freePort(),
    appPort: await freePort(),
    appBundle: path.join(tmp, 'app.js'),
    appOrigin: APP_ORIGIN,
    secretFile: path.join(tmp, 'bridge-secret'),
    certDir: path.join(tmp, 'certs'),
    hosts: ['127.0.0.1'],
    log: () => {},
    ...overrides,
  };
}

/** Plays the bridge app in the editor: connects with the app's origin, says hello, serves requests. */
async function connectApp(target, handlers, { origin = APP_ORIGIN, protocol = 2, wsOptions = {} } = {}) {
  const url = typeof target === 'number' ? `ws://127.0.0.1:${target}/bridge` : target;
  const ws = new WebSocket(url, { origin, ...wsOptions });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', protocol, url, appOrigin: origin, userAgent: 'test', cspViolations: [] }));
  ws.on('message', async (data) => {
    const msg = JSON.parse(String(data));
    try {
      ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result: await handlers[msg.method](msg.params) }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: err.message }));
    }
  });
  await new Promise((r) => setTimeout(r, 30)); // let the hello land
  return ws;
}

async function mcp(host) {
  const server = createServer(loadConfig({ CANVA_TOKEN_FILE: path.join(tmp, 'none.json') }), host);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await client.connect(clientSide);
  return async (name, args = {}) => {
    const res = await client.callTool({ name: `canva_local_${name}`, arguments: args });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { ...res, text, data };
  };
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'canva-bridge-test-'));
  await fs.writeFile(path.join(tmp, 'app.js'), 'console.log("bridge app");');
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('the self-signed certificate covers localhost, 127.0.0.1 and ::1, and is reused', async () => {
  const dir = path.join(tmp, 'certs');
  const first = await ensureCert(dir);
  const x509 = new crypto.X509Certificate(first.cert);
  assert.equal(x509.checkHost('localhost'), 'localhost');
  assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x509.checkIP('::1'), '::1');
  assert.ok(x509.verify(x509.publicKey), 'the self-signature is valid');
  assert.equal(x509.ca, false);
  assert.ok(Date.parse(x509.validTo) - Date.now() < 398 * 86_400_000, 'within the browser validity cap');
  assert.equal((await ensureCert(dir)).fingerprint, first.fingerprint);
});

test('only the pinned app origin is accepted; unpinned, only Canva app iframes', () => {
  assert.ok(appOriginAllowed(APP_ORIGIN, APP_ORIGIN));
  assert.ok(!appOriginAllowed('https://app-other123.canva-apps.com', APP_ORIGIN));
  assert.ok(appOriginAllowed('https://app-other123.canva-apps.com', undefined));
  assert.ok(!appOriginAllowed('https://evil.example', undefined));
  assert.ok(!appOriginAllowed('https://app-x.canva-apps.com.evil.example', undefined));
  assert.ok(!appOriginAllowed('null', undefined));
  assert.ok(!appOriginAllowed(undefined, undefined));
  assert.throws(() => loadConfig({ CANVA_BRIDGE_APP_ORIGIN: 'https://evil.example' }), /canva-apps\.com/);
  assert.equal(loadConfig({ CANVA_BRIDGE_APP_ORIGIN: `${APP_ORIGIN}/` }).bridge.appOrigin, APP_ORIGIN);
});

describe('editing through the bridge', () => {
  let host;
  let opts;
  let call;
  let fake;
  let app;

  before(async () => {
    opts = await hostOptions();
    host = new BridgeHost(opts);
    await host.start();
    call = await mcp(host);
    await freshEditor();
  });

  // Unlike Canva, the fake applies edits immediately (even unsaved ones), so tests that depend on
  // the starting layout get their own editor. The bridge uses the most recently connected app.
  const freshEditor = async () => {
    app?.close();
    fake = createFakeEditor();
    app = await connectApp(opts.port, createHandlers(fake.sdk));
  };

  after(async () => {
    app.close();
    await host.stop();
  });

  test('a page from another origin is refused', async () => {
    await assert.rejects(connectApp(opts.port, {}, { origin: 'https://app-someoneelse.canva-apps.com' }), { status: 403 });
  });

  test('the app bundle is served for the Development URL', async () => {
    const res = await fetch(`http://127.0.0.1:${opts.appPort}/`);
    assert.equal(res.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(await res.text(), 'console.log("bridge app");');
  });

  test('editor-status shows the connection, design, design ID and pages', async () => {
    const res = await call('editor-status');
    assert.equal(res.data.bridge.mode, 'owner');
    assert.equal(res.data.bridge.originPinned, APP_ORIGIN);
    assert.equal(res.data.bridge.apps.length, 1);
    assert.equal(res.data.design.title, 'Launch deck');
    assert.equal(res.data.design.designId, 'DAFAKE123');
    assert.equal(res.data.design.currentPage, 1);
    assert.deepEqual(res.data.design.pages.map((p) => p.id), ['PAGE1', 'PAGE2']);
    assert.equal(res.data.next, undefined);
  });

  test('read-page describes elements with paths and keys', async () => {
    const res = await call('read-page');
    assert.equal(res.isError, undefined, res.text);
    const c = res.data;
    assert.equal(c.page, 1);
    assert.deepEqual(c.background, { color: '#ffffff' });
    assert.deepEqual(c.elements.map((e) => `${e.path}:${e.type}`), ['0:rect', '1:text', '2:group', '3:text', '4:rect']);
    assert.deepEqual(c.elements[0].fill, { media: 'image' });
    assert.equal(c.elements[1].text, 'Q3 Launch Plan', 'trailing paragraph break is hidden');
    assert.equal(c.elements[1].regions, undefined, 'formatting is opt-in');
    assert.equal(c.elements[2].children[0].path, '2.0');
    assert.equal(c.elements[2].children[1].paths[0].fill.color, '#ff0000');
    assert.equal(c.elements[3].locked, true);
    assert.match(c.elements[1].key, /^[0-9a-f]{8}$/);
    const withFormatting = await call('read-page', { formatting: true });
    assert.ok(withFormatting.data.elements[1].regions.length);
  });

  test('read-page can read another page by number', async () => {
    const res = await call('read-page', { page: 2 });
    assert.equal(res.data.page, 2);
    assert.equal(res.data.elements[0].text, 'Page two title');
  });

  test('edit-page applies a batch and saves it once', async () => {
    const before = (await call('read-page')).data;
    const syncs = fake.syncs();
    const res = await call('edit-page', {
      operations: [
        { op: 'set_text', element: '1', key: before.elements[1].key, text: 'Q4 Launch Plan', formatting: { fontWeight: 'bold', fontSize: 96 } },
        { op: 'replace_text', element: '2.0', find: 'goes here', replace: 'for the board' },
        { op: 'format_text', element: '1', find: 'Q4', formatting: { color: '#ff6600' } },
        { op: 'transform', element: '4', left: 1400, rotation: 15 },
        { op: 'set_fill', element: '4', color: '#123456' },
        { op: 'set_fill', element: '2.1', color: '#00ff00' },
        { op: 'set_stroke', element: '4', color: '#ffffff', weight: 4 },
        { op: 'set_background', color: '#fafafa' },
        { op: 'insert_text', text: 'New note', top: 900, left: 100, width: 400, formatting: { fontSize: 32 } },
        { op: 'insert_rect', top: 10, left: 10, width: 50, height: 50, color: '#abcdef' },
        { op: 'reorder', element: '0', to: 'front' },
      ],
    });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(res.data.saved, true);
    assert.equal(fake.syncs(), syncs + 1, 'one save for the whole batch');
    assert.equal(res.data.applied.length, 11);
    assert.match(res.data.applied[0].detail, /"Q3 Launch Plan" -> "Q4 Launch Plan"/);

    const page = fake.pages[0];
    const title = page.elements.items.find((e) => e.type === 'text' && e.text.readPlaintext().startsWith('Q4'));
    assert.equal(title.text.readPlaintext(), 'Q4 Launch Plan\n', 'the paragraph break survives set_text');
    assert.deepEqual(title.text.formats[0], ['inline', 0, 14, { fontWeight: 'bold' }]);
    assert.deepEqual(title.text.formats[1], ['paragraph', 0, 14, { fontSize: 96 }]);
    assert.deepEqual(title.text.formats[2], ['inline', 0, 2, { color: '#ff6600' }]);
    const group = page.elements.items.find((e) => e.type === 'group');
    assert.equal(group.contents.items[0].text.readPlaintext(), 'Subtitle for the board\n');
    assert.equal(group.contents.items[1].paths.items[0].fill.colorContainer.ref.color, '#00ff00');
    const card = page.elements.items.find((e) => e.type === 'rect' && e.fill.colorContainer.ref?.color === '#123456');
    assert.equal(card.left, 1400);
    assert.equal(card.rotation, 15);
    assert.equal(card.stroke.weight, 4);
    assert.equal(page.background.colorContainer.ref.color, '#fafafa');
    assert.equal(page.elements.items.at(-1).fill.mediaContainer.ref.type, 'image', 'the photo moved to the front');
    const content = res.data.content;
    assert.equal(content.elements.length, 7);
    assert.ok(content.elements.some((e) => e.text === 'New note'));
  });

  test('a stale key rejects the whole batch before anything changes', async () => {
    await freshEditor();
    const syncs = fake.syncs();
    const res = await call('edit-page', {
      operations: [
        { op: 'set_background', color: '#000000' },
        { op: 'set_text', element: '1', key: 'deadbeef', text: 'nope' },
      ],
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /changed since it was read/);
    assert.equal(fake.syncs(), syncs);
    assert.equal(fake.pages[0].background.colorContainer.ref.color, '#ffffff', 'targets are checked before any operation runs');
  });

  test('a failing operation names itself and nothing is saved', async () => {
    await freshEditor();
    const syncs = fake.syncs();
    const res = await call('edit-page', { operations: [{ op: 'replace_text', element: '1', find: 'not there', replace: 'x' }] });
    assert.equal(res.isError, true);
    assert.match(res.text, /Operation 1 \(replace_text on 1\) failed, so nothing was saved: "not there" wasn't found/);
    assert.equal(fake.syncs(), syncs);
  });

  test('locked elements, group children and resizing are refused with reasons', async () => {
    await freshEditor();
    const page = (await call('read-page')).data;
    const locked = page.elements.find((e) => e.locked);
    const lockedRes = await call('edit-page', { operations: [{ op: 'set_text', element: locked.path, text: 'x' }] });
    assert.match(lockedRes.text, /is locked/);
    const childDelete = await call('edit-page', { operations: [{ op: 'delete', element: '2.0' }] });
    assert.match(childDelete.text, /only works on top-level elements/);
    const resize = await call('edit-page', { operations: [{ op: 'transform', element: '1', width: 300 }] });
    assert.equal(resize.isError, true, 'width is not part of transform');
    assert.match(resize.text, /width/);
  });

  test('dryRun reports the result without saving', async () => {
    await freshEditor();
    const syncs = fake.syncs();
    const res = await call('edit-page', { dryRun: true, operations: [{ op: 'delete', element: '0' }] });
    assert.equal(res.data.saved, false);
    assert.equal(fake.syncs(), syncs);
  });

  test('insert_image uploads local files and https URLs, then places them as their own elements', async () => {
    await freshEditor();
    const png = path.join(tmp, 'screen.png');
    await fs.writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    const res = await call('edit-page', {
      operations: [
        { op: 'insert_image', file: png, top: 300, left: 110, width: 280, height: 600 },
        { op: 'insert_image', url: 'https://example.com/photos/house.jpg', top: 300, left: 500, width: 400, height: 300, radius: 24, name: 'House' },
      ],
    });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(fake.uploads.length, 2);
    assert.match(fake.uploads[0].url, /^data:image\/png;base64,iVBORw0KGgo/);
    assert.equal(fake.uploads[0].mimeType, 'image/png');
    assert.equal(fake.uploads[0].name, 'screen.png');
    assert.equal(fake.uploads[0].aiDisclosure, 'none');
    assert.deepEqual([fake.uploads[1].url, fake.uploads[1].mimeType, fake.uploads[1].name], ['https://example.com/photos/house.jpg', 'image/jpeg', 'House']);
    const [rect, shape] = fake.pages[0].elements.items.slice(-2);
    assert.equal(rect.type, 'rect');
    assert.deepEqual(rect.fill.mediaContainer.ref, { type: 'image', imageRef: 'IMAGEREF1' });
    assert.deepEqual([rect.left, rect.top, rect.width, rect.height], [110, 300, 280, 600]);
    assert.equal(shape.type, 'shape', 'a radius puts the image in a rounded frame');
    assert.equal(shape.paths.items[0].fill.mediaContainer.ref.imageRef, 'IMAGEREF2');
    assert.match(shape.paths.items[0].d, /^M24 0 L376 0 C/);
    assert.equal(res.data.content.elements.at(-1).paths[0].fill.media, 'image');
  });

  test('insert_image refuses bad sources before anything is uploaded, and dry runs upload nothing', async () => {
    await freshEditor();
    const bad = [
      [{ file: path.join(tmp, 'a.png'), url: 'https://example.com/a.png' }, /exactly one of file or url/],
      [{ file: path.join(tmp, 'notes.txt') }, /isn't a PNG, JPEG/],
      [{ file: path.join(tmp, 'missing.png') }, /can't read/],
      [{ url: 'http://example.com/a.png' }, /only fetches https/],
      [{ url: 'https://example.com/image' }, /end in the image's file extension/],
    ];
    for (const [source, message] of bad) {
      const res = await call('edit-page', { operations: [{ op: 'insert_image', ...source, top: 0, left: 0, width: 10, height: 10 }] });
      assert.equal(res.isError, true, JSON.stringify(source));
      assert.match(res.text, message);
    }
    const dry = await call('edit-page', { dryRun: true, operations: [{ op: 'insert_image', url: 'https://example.com/a.png', top: 0, left: 0, width: 10, height: 10 }] });
    assert.equal(dry.data.saved, false);
    assert.match(dry.data.applied[0].detail, /dry run/);
    assert.equal(fake.uploads.length, 0);
  });

  test('colors are sent lowercase and Q curves as C, the forms Canva accepts', async () => {
    await freshEditor();
    const res = await call('edit-page', {
      operations: [
        { op: 'set_background', color: '#FAFAFA' },
        { op: 'insert_text', text: 'Hi', top: 0, left: 0, width: 100, formatting: { color: '#AF1E3D' } },
        { op: 'insert_rect', top: 0, left: 0, width: 10, height: 10, color: '#ABCDEF', strokeColor: '#00FF00' },
        {
          op: 'insert_shape',
          top: 0,
          left: 0,
          width: 330,
          height: 104,
          viewBox: { top: 0, left: 0, width: 330, height: 104 },
          paths: [{ d: 'M6 0 H324 Q330 0 330 6 V98 Z', color: '#F4F4F4' }],
        },
      ],
    });
    assert.equal(res.isError, undefined, res.text);
    const page = fake.pages[0];
    assert.equal(page.background.colorContainer.ref.color, '#fafafa');
    const [text, rect, shape] = page.elements.items.slice(-3);
    assert.equal(text.insertedFormatting.color, '#af1e3d');
    assert.equal(rect.fill.colorContainer.ref.color, '#abcdef');
    assert.equal(rect.stroke.colorContainer.ref.color, '#00ff00');
    assert.equal(shape.paths.items[0].d, 'M6 0 L324 0 C328 0 330 2 330 6 L330 98 Z');
    assert.equal(shape.paths.items[0].fill.colorContainer.ref.color, '#f4f4f4');
  });

  test('a path Canva would refuse on save fails a dry run the same way', async () => {
    await freshEditor();
    const syncs = fake.syncs();
    const shape = { op: 'insert_shape', top: 0, left: 0, width: 10, height: 10, viewBox: { top: 0, left: 0, width: 10, height: 10 }, paths: [{ d: 'M0 0 L10 0 L10 10' }] };
    for (const dryRun of [true, false]) {
      const res = await call('edit-page', { dryRun, operations: [shape] });
      assert.equal(res.isError, true, `dryRun ${dryRun}`);
      assert.match(res.text, /only draws closed paths/);
    }
    const square = (i) => ({ d: `M${i} 0 L${i + 1} 0 L${i + 1} 1 Z`, color: `#00000${i}` });
    const sevenColors = await call('edit-page', { dryRun: true, operations: [{ ...shape, paths: [0, 1, 2, 3, 4, 5, 6].map(square) }] });
    assert.match(sevenColors.text, /at most 6 different fill colors per shape; these paths use 7/);
    const big = { d: `M0 0 ${'L1 1 '.repeat(420)}Z` };
    const tooBig = await call('edit-page', { dryRun: true, operations: [{ ...shape, paths: [big] }] });
    assert.match(tooBig.text, /at most 2 KB of path data per shape/);
    assert.equal(fake.syncs(), syncs);
    assert.equal(fake.pages[0].elements.items.length, 5, 'nothing was inserted');
  });

  test('a slide converted by svg2canva passes edit-page, text formats included', async () => {
    await freshEditor();
    const { ops, formats } = convertSvg(sampleSvg);
    const res = await call('edit-page', { operations: ops });
    assert.equal(res.isError, undefined, res.text);
    const inserted = ops.filter((o) => o.op !== 'set_background').length;
    const base = res.data.content.elements.length - inserted;
    assert.equal(base, 5, 'the page\'s own elements stay underneath');
    const formatted = await call('edit-page', { operations: formats.map((p) => ({ op: 'format_text', element: String(base + p.insert), find: p.find, formatting: p.formatting })) });
    assert.equal(formatted.isError, undefined, formatted.text);
    const title = fake.pages[0].elements.items[base + formats[0].insert];
    assert.equal(title.text.readPlaintext(), 'Title\nSecond line\n');
    assert.deepEqual(title.text.formats.at(-1), ['inline', 6, 11, { color: '#ffffff', fontWeight: 'normal' }]);
  });

  test('group and ungroup restructure top-level elements', async () => {
    await freshEditor();
    const before = (await call('read-page')).data.elements.length;
    const grouped = await call('edit-page', { operations: [{ op: 'group', elements: ['0', '1'] }] });
    assert.equal(grouped.isError, undefined, grouped.text);
    assert.equal(grouped.data.content.elements.length, before - 1);
    const groupPath = grouped.data.content.elements.find((e) => e.type === 'group' && e.children.length === 2 && e.children[0].type !== 'text')?.path;
    assert.ok(groupPath);
    const ungrouped = await call('edit-page', { operations: [{ op: 'ungroup', element: groupPath }] });
    assert.equal(ungrouped.data.content.elements.length, before);
  });

  test('edits on another page go through that page and are saved once it is closed', async () => {
    const syncs = fake.syncs();
    const res = await call('edit-page', { page: 2, operations: [{ op: 'set_text', element: '0', text: 'Renamed page two' }] });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(res.data.saved, true);
    assert.equal(fake.syncs(), syncs + 1);
    assert.equal(fake.pages[1].elements.items[0].text.readPlaintext(), 'Renamed page two\n');
    const missing = await call('edit-page', { page: 9, operations: [{ op: 'set_background', color: '#000000' }] });
    assert.match(missing.text, /Page 9 doesn't exist; the design has 2 pages/);
  });
});

describe('several canva-mcp instances', () => {
  test('a second instance relays through the first, and takes over when it exits', async () => {
    const opts = await hostOptions();
    const first = new BridgeHost(opts);
    await first.start();
    const second = new BridgeHost(opts);
    await second.start();
    const fake = createFakeEditor();
    let app = await connectApp(opts.port, createHandlers(fake.sdk));

    const relayed = await second.status();
    assert.equal(relayed.mode, 'relay');
    assert.equal(relayed.apps.length, 1);
    const page = await second.request('read_page', {}, 5000);
    assert.equal(page.elements[1].text, 'Q3 Launch Plan');

    app.close();
    await first.stop();
    // The second instance notices the owner is gone and claims the ports.
    const deadline = Date.now() + 5000;
    let status;
    do {
      await new Promise((r) => setTimeout(r, 100));
      status = await second.status();
    } while (status.mode !== 'owner' && Date.now() < deadline);
    assert.equal(status.mode, 'owner');
    app = await connectApp(opts.port, createHandlers(fake.sdk));
    const again = await second.request('ping', undefined, 5000);
    assert.equal(again.pong, true);
    app.close();
    await second.stop();
  });

  test('an uploaded app can connect over wss, and failed handshakes are counted', async () => {
    const opts = await hostOptions({ tlsPort: await freePort() });
    const host = new BridgeHost(opts);
    await host.start();
    // A browser that hasn't accepted the certificate aborts the TLS handshake; any non-TLS bytes fail it the same way.
    await new Promise((resolve) => {
      const socket = net.connect(opts.tlsPort, '127.0.0.1', () => socket.end('GET / HTTP/1.1\r\n\r\n'));
      socket.on('close', resolve);
      socket.on('error', () => {});
    });
    let status = await host.status();
    assert.equal(status.tlsRejected?.count, 1);
    const call = await mcp(host);
    const hint = await call('editor-status');
    assert.match(hint.data.next, /rejected the bridge's local certificate 1 time/);

    const fake = createFakeEditor();
    const url = `wss://localhost:${opts.tlsPort}/bridge`;
    const app = await connectApp(url, createHandlers(fake.sdk), { wsOptions: { rejectUnauthorized: false } });
    status = await host.status();
    assert.equal(status.apps[0].url, url);
    const page = await host.request('read_page', {}, 5000);
    assert.equal(page.elements[1].text, 'Q3 Launch Plan');
    app.close();
    await host.stop();
  });

  test('a port held by something else is reported, not crashed on', async () => {
    const opts = await hostOptions();
    const squatter = http.createServer((_req, res) => res.end('not a bridge'));
    await new Promise((r) => squatter.listen(opts.port, '127.0.0.1', r));
    const host = new BridgeHost(opts);
    await host.start();
    const status = await host.status();
    assert.equal(status.mode, 'unavailable');
    assert.match(status.problem, /in use by a program that isn't a canva-mcp bridge/);
    await assert.rejects(host.request('ping', undefined, 1000), /in use/);
    await host.stop();
    await new Promise((r) => squatter.close(r));
  });

  test('requests explain what to do when no editor or an old app is connected', async () => {
    const opts = await hostOptions();
    const host = new BridgeHost(opts);
    await host.start();
    await assert.rejects(host.request('ping', undefined, 1000), /No Canva editor is connected/);
    const old = await connectApp(opts.port, {}, { protocol: 1 });
    await assert.rejects(host.request('ping', undefined, 1000), /older version.*reload/);
    old.close();
    await host.stop();
  });
});
