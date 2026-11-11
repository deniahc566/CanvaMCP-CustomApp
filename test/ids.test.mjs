import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designId, folderId } from '../dist/canva/ids.js';

test('design IDs come out of every kind of canva.com design link', () => {
  assert.equal(designId('DAGQm3AbCdE'), 'DAGQm3AbCdE');
  assert.equal(designId('  DAGQm3AbCdE '), 'DAGQm3AbCdE');
  assert.equal(designId('https://www.canva.com/design/DAGQm3AbCdE/edit'), 'DAGQm3AbCdE');
  assert.equal(designId('https://www.canva.com/design/DAGQm3AbCdE/x9TokEn/view?utm_content=a&mode=preview'), 'DAGQm3AbCdE');
  assert.equal(designId('canva.com/design/DAG_-9/watch'), 'DAG_-9');
});

test('other links are rejected with a pointer to the right tool', () => {
  assert.throws(() => designId('https://canva.link/abc123'), /resolve-shortlink/);
  assert.throws(() => designId('https://example.com/design/DAG1'), /not a canva\.com\/design/);
  assert.throws(() => designId('   '), /required/);
});

test('folder IDs accept links and the special root/uploads IDs', () => {
  assert.equal(folderId('root'), 'root');
  assert.equal(folderId('uploads'), 'uploads');
  assert.equal(folderId('https://www.canva.com/folder/FAFabc123'), 'FAFabc123');
});
