import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';

async function toolNames(env) {
  const server = createServer(loadConfig(env));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'naming', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  await client.close();
  return { names: tools.map((t) => t.name).sort(), tools, instructions };
}

test('defaults to the canva_local_ prefix', async () => {
  const { names } = await toolNames({});
  assert.ok(names.every((n) => n.startsWith('canva_local_')), names.join(', '));
  assert.equal(names.length, 39);
  assert.ok(names.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n)), 'every name fits MCP tool-name rules');
});

test('an empty prefix restores the official tool names', async () => {
  const { names, tools, instructions } = await toolNames({ CANVA_TOOL_PREFIX: '' });
  for (const official of ['search-designs', 'get-design', 'export-design', 'autofill-design', 'import-design-from-url', 'comment-on-design']) {
    assert.ok(names.includes(official), official);
  }
  assert.match(tools.find((t) => t.name === 'whoami').description, /call login\./);
  assert.doesNotMatch(instructions, /<official name>/);
});

test('a custom prefix is applied to names and cross-references', async () => {
  const { names, tools, instructions } = await toolNames({ CANVA_TOOL_PREFIX: 'acme_' });
  assert.ok(names.includes('acme_export-design'));
  assert.match(tools.find((t) => t.name === 'acme_create-design').description, /use acme_generate-design/);
  assert.match(instructions, /acme_get-job/);
});

test('rejects prefixes with characters tool names cannot hold', () => {
  assert.throws(() => loadConfig({ CANVA_TOOL_PREFIX: 'bad prefix!' }), /CANVA_TOOL_PREFIX may only contain/);
});

test('rejects redirect URIs that are not loopback http with a port', () => {
  assert.throws(() => loadConfig({ CANVA_REDIRECT_URI: 'https://example.com/cb' }), /loopback http URL/);
  assert.throws(() => loadConfig({ CANVA_REDIRECT_URI: 'http://127.0.0.1/cb' }), /loopback http URL/);
  assert.equal(loadConfig({}).redirectUri, 'http://127.0.0.1:3001/oauth/redirect');
});
