import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TokenManager, TokenStore } from '../dist/canva/auth.js';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';
import { PNG, startMockCanva } from './mock-canva.mjs';

let mock;
let tmp;
let env;

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function seedTokens(overrides = {}) {
  const t = mock.issue();
  const tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + 3_600_000,
    client_id: 'test-client',
    obtained_at: Date.now(),
    ...overrides,
  };
  await fs.writeFile(env.CANVA_TOKEN_FILE, JSON.stringify(tokens));
  return tokens;
}

async function connect(extraEnv = {}) {
  const server = createServer(loadConfig({ ...env, ...extraEnv }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name: `canva_local_${name}`, arguments: args });
    const text = res.content.find((c) => c.type === 'text')?.text;
    let data;
    try {
      data = text && JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { ...res, text, data };
  };
  return { client, call };
}

before(async () => {
  mock = await startMockCanva();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'canva-mcp-test-'));
});

after(async () => {
  await mock.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  env = {
    CANVA_CLIENT_ID: 'test-client',
    CANVA_CLIENT_SECRET: 'cnvca-test-secret',
    CANVA_API_BASE: `${mock.base}/rest`,
    CANVA_AUTH_BASE: mock.base,
    CANVA_TOKEN_FILE: path.join(tmp, `tokens-${Date.now()}-${Math.random()}.json`),
    CANVA_REDIRECT_URI: `http://127.0.0.1:${await freePort()}/oauth/redirect`,
    CANVA_DOWNLOAD_DIR: path.join(tmp, 'downloads'),
  };
  mock.state.requests.length = 0;
  mock.state.tokenCalls.length = 0;
  mock.state.exportPolls = 1;
});

describe('auth', () => {
  test('login runs the PKCE flow and saves the tokens', async () => {
    const auth = new TokenManager(loadConfig(env), new TokenStore(env.CANVA_TOKEN_FILE));
    const pending = await auth.startLogin(10_000);
    const authorize = new URL(pending.url);
    assert.equal(authorize.origin + authorize.pathname, `${mock.base}/api/oauth/authorize`);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 's256');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('redirect_uri'), env.CANVA_REDIRECT_URI);
    assert.match(authorize.searchParams.get('scope'), /design:content:write/);

    // Plays the browser: the mock "approves" and redirects back to the loopback listener.
    const page = await fetch(pending.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Canva is connected/);
    const tokens = await pending.done;

    const exchange = mock.state.tokenCalls.at(-1);
    assert.equal(exchange.grant_type, 'authorization_code');
    assert.ok(exchange.code_verifier.length >= 43, 'PKCE verifier is sent');
    assert.equal(exchange.redirect_uri, env.CANVA_REDIRECT_URI);
    const saved = JSON.parse(await fs.readFile(env.CANVA_TOKEN_FILE, 'utf8'));
    assert.equal(saved.access_token, tokens.access_token);
    assert.equal((await auth.status()).signedIn, true);
  });

  test('`canva-mcp login` keeps running until the browser comes back', async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'login'], {
      env: { ...process.env, ...env, CANVA_NO_BROWSER: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const deadline = Date.now() + 10_000;
    let url;
    while (!(url = out.match(/https?:\/\/\S+\/api\/oauth\/authorize\S+/)?.[0])) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`no sign-in URL printed:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    // With nothing else keeping Node alive, the command used to exit right here, before the redirect.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(child.exitCode, null, `the command exited while waiting for the redirect:\n${out}`);
    const page = await fetch(url);
    assert.match(await page.text(), /Canva is connected/);
    assert.equal(await exited, 0, out);
    assert.match(out, /Signed in\. Tokens saved to/);
  });

  test('a callback with the wrong state is refused and the login keeps waiting', async () => {
    const auth = new TokenManager(loadConfig(env), new TokenStore(env.CANVA_TOKEN_FILE));
    const pending = await auth.startLogin(10_000);
    const forged = await fetch(`${env.CANVA_REDIRECT_URI}?code=code-x&state=forged`);
    assert.equal(forged.status, 400);
    await fetch(pending.url);
    await pending.done;
  });

  test('an expired access token is refreshed and the rotated pair is persisted', async () => {
    const seeded = await seedTokens({ expires_at: Date.now() - 1000 });
    const { call } = await connect();
    const res = await call('search-designs', { query: 'deck' });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(res.data.designs[0].title, 'Quarterly deck');
    assert.equal(res.data.designs[0].thumbnail.url, undefined, 'lists drop signed thumbnail URLs');
    assert.deepEqual(mock.state.tokenCalls.map((c) => c.grant_type), ['refresh_token']);
    const saved = JSON.parse(await fs.readFile(env.CANVA_TOKEN_FILE, 'utf8'));
    assert.notEqual(saved.refresh_token, seeded.refresh_token);
    assert.ok(saved.expires_at > Date.now());
  });

  test('two processes refreshing at once spend the single-use refresh token only once', async () => {
    await seedTokens({ expires_at: Date.now() - 1000 });
    const a = new TokenManager(loadConfig(env), new TokenStore(env.CANVA_TOKEN_FILE));
    const b = new TokenManager(loadConfig(env), new TokenStore(env.CANVA_TOKEN_FILE));
    const [ta, tb] = await Promise.all([a.getAccessToken(), b.getAccessToken()]);
    assert.equal(ta, tb);
    assert.equal(mock.state.tokenCalls.length, 1);
  });

  test('a 401 mid-session triggers one refresh and a retry', async () => {
    await seedTokens();
    const { call } = await connect();
    mock.state.reject401Once = true;
    const res = await call('get-design', { designId: 'https://www.canva.com/design/DAF9/abc/edit' });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(res.data.id, 'DAF9');
    assert.equal(mock.state.tokenCalls.length, 1);
  });

  test('tools explain how to sign in when there are no tokens', async () => {
    const { call } = await connect();
    const res = await call('search-designs', {});
    assert.equal(res.isError, true);
    assert.match(res.text, /Not signed in to Canva.*login tool/);
    const who = await call('whoami');
    assert.equal(who.data.auth.signedIn, false);
  });
});

describe('tools', () => {
  test('whoami reports the account and capabilities', async () => {
    await seedTokens();
    const { call } = await connect();
    const res = await call('whoami');
    assert.deepEqual(res.data.user, { user_id: 'U1', team_id: 'T1' });
    assert.equal(res.data.displayName, 'Test User');
    assert.deepEqual(res.data.capabilities, ['resize']);
  });

  test('export-design waits for the job and downloads every page', async () => {
    await seedTokens();
    const { call } = await connect();
    const res = await call('export-design', { designId: 'DAF1', format: { type: 'png', width: 800, transparentBackground: true, quality: 50 }, download: true });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(res.data.files.length, 2);
    assert.deepEqual(await fs.readFile(res.data.files[0]), PNG);
    const created = mock.state.requests.find((r) => r.path === '/rest/v1/exports');
    const sent = JSON.parse(created.body.toString());
    assert.deepEqual(sent.format, { type: 'png', width: 800, transparent_background: true }, 'jpg-only quality is dropped for png');
  });

  test('a job that outlives the wait hands back a get-job call that finishes it', async () => {
    await seedTokens();
    mock.state.exportPolls = 2;
    const { call } = await connect({ CANVA_JOB_TIMEOUT_MS: '1' });
    const res = await call('export-design', { designId: 'DAF1', format: { type: 'jpg' } });
    assert.equal(res.data.status, 'in_progress');
    assert.match(res.data.next, /canva_local_get-job.*kind "export"/);
    const sent = JSON.parse(mock.state.requests.find((r) => r.path === '/rest/v1/exports').body.toString());
    assert.equal(sent.format.quality, 90, 'jpg gets a default quality');
    const done = await call('get-job', { kind: 'export', jobId: res.data.jobId, waitSeconds: 10 });
    assert.equal(done.data.status, 'success');
    assert.equal(done.data.urls.length, 2);
  });

  test('upload-asset-from-file sends the bytes with base64 name metadata', async () => {
    await seedTokens();
    const file = path.join(tmp, 'Logo ✓.png');
    await fs.writeFile(file, PNG);
    const { call } = await connect();
    const res = await call('upload-asset-from-file', { filePath: file });
    assert.equal(res.data.asset.id, 'ASSET1');
    const upload = mock.state.uploads.at(-1);
    assert.equal(Buffer.from(upload.metadata.name_base64, 'base64').toString('utf8'), 'Logo ✓');
    assert.equal(upload.contentType, 'application/octet-stream');
    assert.deepEqual(upload.bytes, PNG);
  });

  test('list-folder-items joins item_types with commas and defaults to root', async () => {
    await seedTokens();
    const { call } = await connect();
    const res = await call('list-folder-items', { itemTypes: ['design', 'folder'], pinnedOnly: true });
    const req = mock.state.requests.at(-1);
    assert.equal(req.path, '/rest/v1/folders/root/items');
    assert.equal(req.query.item_types, 'design,folder');
    assert.equal(req.query.pin_status, 'pinned');
    assert.deepEqual(res.data.items.map((i) => i.type), ['folder', 'design']);
  });

  test('get-design-thumbnail returns the image itself', async () => {
    await seedTokens();
    const { call } = await connect();
    const res = await call('get-design-thumbnail', { designId: 'DAF1', pageNumber: 2 });
    const img = res.content.find((c) => c.type === 'image');
    assert.equal(img.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(img.data, 'base64'), PNG);
    assert.equal(mock.state.requests.at(-1).query.offset, '2');
  });

  test('create-design sends a type_and_asset request', async () => {
    await seedTokens();
    const { call } = await connect();
    const res = await call('create-design', { designType: { type: 'custom', width: 1080, height: 1080 }, title: 'Post' });
    assert.equal(res.data.title, 'Post');
    const sent = JSON.parse(mock.state.requests.at(-1).body.toString());
    assert.deepEqual(sent, { type: 'type_and_asset', design_type: { type: 'custom', width: 1080, height: 1080 }, title: 'Post' });
    const none = await call('create-design', {});
    assert.equal(none.isError, true);
  });

  test('API errors come back as readable tool errors with a hint', async () => {
    await seedTokens();
    const { call } = await connect();
    const res = await call('get-design', { designId: 'DAFORBIDDEN' });
    assert.equal(res.isError, true);
    assert.match(res.text, /403 permission_denied.*Missing scopes.*Developer Portal/);
  });
});
