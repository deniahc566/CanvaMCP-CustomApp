// Builds the app into dist/app.js, the single bundle Canva loads. With --serve, rebuilds on change and
// serves it the way Canva's own dev server does: GET / (and /app.js) return the bundle.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, 'dist', 'app.js');
const serve = process.argv.includes('--serve');
const port = Number(process.env.BRIDGE_APP_PORT) || 8080;

const options = {
  entryPoints: [path.join(here, 'src', 'index.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: serve ? 'inline' : false,
  minify: !serve,
  logLevel: 'info',
};

if (!serve) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();

  const headers = {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  };
  const handler = async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, headers).end();
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/' && pathname !== '/app.js') return res.writeHead(404).end();
    try {
      res.writeHead(200, headers).end(await fs.readFile(outfile));
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Still building, retry in a moment.');
    }
  };
  // Loopback only, on both stacks, since the Developer Portal URL says "localhost".
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolve) => {
      const server = http.createServer(handler);
      server.once('error', (err) => {
        if (host === '127.0.0.1') console.error(`Could not listen on ${host}:${port}: ${err.message}`);
        resolve();
      });
      server.listen(port, host, resolve);
    });
  }
  console.log(`\nBridge app served at http://localhost:${port} - set this as the Development URL in the Developer Portal.`);
}
