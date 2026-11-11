// A small stand-in for the Canva Connect API and OAuth endpoints, enough to drive every code path
// the tests touch: auth-code exchange, single-use refresh tokens, async jobs, uploads and downloads.
import http from 'node:http';

// 1x1 transparent PNG.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export async function startMockCanva() {
  const state = {
    clientId: 'test-client',
    clientSecret: 'cnvca-test-secret',
    /** refresh tokens Canva still accepts; each is removed when used */
    liveRefresh: new Set(),
    liveAccess: new Set(),
    tokenCalls: [],
    requests: [],
    seq: 0,
    /** how many polls an export job stays in_progress */
    exportPolls: 1,
    /** force the next API call to answer 401 */
    reject401Once: false,
    jobs: new Map(),
    uploads: [],
  };

  const issue = () => {
    const n = ++state.seq;
    const access = `access-${n}`;
    const refresh = `refresh-${n}`;
    state.liveAccess.add(access);
    state.liveRefresh.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 14400, scope: 'design:meta:read design:content:read' };
  };

  const design = (id, title = 'Test design') => ({
    id,
    title,
    owner: { user_id: 'U1', team_id: 'T1' },
    thumbnail: { width: 100, height: 100, url: `${base}/files/thumb.png?sig=1` },
    urls: { edit_url: `https://www.canva.com/design/${id}/edit`, view_url: `https://www.canva.com/design/${id}/view` },
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    page_count: 2,
    design_types: ['presentation'],
  });

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const body = await readBody(req);
    const p = url.pathname;

    if (p === '/api/oauth/authorize') {
      // Stand-in for the user approving access: bounce straight back to the redirect URI.
      const code = `code-${++state.seq}`;
      state.lastAuthorize = Object.fromEntries(url.searchParams);
      state.codes = { ...state.codes, [code]: url.searchParams.get('code_challenge') };
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }

    if (p === '/files/thumb.png' || p.startsWith('/files/export')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }).end(PNG);
      return;
    }

    if (p === '/rest/v1/oauth/token') {
      const expected = 'Basic ' + Buffer.from(`${state.clientId}:${state.clientSecret}`).toString('base64');
      const form = new URLSearchParams(body.toString());
      state.tokenCalls.push(Object.fromEntries(form));
      if (req.headers.authorization !== expected) return send(res, 401, { error: 'invalid_client', error_description: 'bad client credentials' });
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return send(res, 400, { error: 'invalid_request', error_description: 'form body required' });
      if (form.get('grant_type') === 'authorization_code') {
        if (!state.codes?.[form.get('code')] || !form.get('code_verifier')) return send(res, 400, { error: 'invalid_grant', error_description: 'bad code' });
        delete state.codes[form.get('code')];
        return send(res, 200, issue());
      }
      if (form.get('grant_type') === 'refresh_token') {
        const rt = form.get('refresh_token');
        if (!state.liveRefresh.has(rt)) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token already used' });
        state.liveRefresh.delete(rt);
        return send(res, 200, issue());
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (!p.startsWith('/rest/v1/')) return send(res, 404, { code: 'endpoint_not_found', message: p });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    state.requests.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body, token });
    if (state.reject401Once || !state.liveAccess.has(token)) {
      state.reject401Once = false;
      return send(res, 401, { code: 'invalid_access_token', message: 'Access token is invalid' });
    }
    const api = p.slice('/rest'.length);
    const json = body.length && req.headers['content-type'] === 'application/json' ? JSON.parse(body.toString()) : undefined;

    if (api === '/v1/users/me') return send(res, 200, { team_user: { user_id: 'U1', team_id: 'T1' } });
    if (api === '/v1/users/me/profile') return send(res, 200, { profile: { display_name: 'Test User' } });
    if (api === '/v1/users/me/capabilities') return send(res, 200, { capabilities: ['resize'] });
    if (api === '/v1/designs' && req.method === 'GET') return send(res, 200, { items: [design('DAF1', 'Quarterly deck'), design('DAF2')], continuation: 'next-page' });
    if (api === '/v1/designs' && req.method === 'POST') return send(res, 200, { design: design('DANEW', json?.title) });
    if (api === '/v1/designs/DAFORBIDDEN') return send(res, 403, { code: 'permission_denied', message: 'Missing scopes: [design:meta:read]' });
    if (/^\/v1\/designs\/[^/]+$/.test(api)) return send(res, 200, { design: design(api.split('/').pop()) });
    if (/^\/v1\/designs\/[^/]+\/pages$/.test(api)) {
      return send(res, 200, { items: [{ index: 1, page_number: Number(url.searchParams.get('offset') ?? 1), thumbnail: { width: 50, height: 50, url: `${base}/files/thumb.png` }, design_type: 'presentation' }] });
    }
    if (api === '/v1/exports' && req.method === 'POST') {
      const id = `export-${++state.seq}`;
      state.jobs.set(id, { polls: 0, format: json.format, design: json.design_id });
      return send(res, 200, { job: { id, status: 'in_progress' } });
    }
    if (api.startsWith('/v1/exports/')) {
      const id = api.split('/').pop();
      const job = state.jobs.get(id);
      if (!job) return send(res, 404, { code: 'not_found', message: 'no such job' });
      if (job.polls++ < state.exportPolls) return send(res, 200, { job: { id, status: 'in_progress' } });
      return send(res, 200, { job: { id, status: 'success', urls: [`${base}/files/export-1.png`, `${base}/files/export-2.png`] } });
    }
    if (api === '/v1/asset-uploads' && req.method === 'POST') {
      state.uploads.push({ metadata: JSON.parse(req.headers['asset-upload-metadata']), bytes: body, contentType: req.headers['content-type'] });
      return send(res, 200, { job: { id: 'upload-1', status: 'success', asset: { type: 'image', id: 'ASSET1', name: 'logo', tags: [], created_at: 1, updated_at: 1 } } });
    }
    if (/^\/v1\/folders\/[^/]+\/items$/.test(api)) {
      return send(res, 200, {
        items: [
          { type: 'folder', folder: { id: 'FAF1', name: 'Brand', created_at: 1, updated_at: 2 } },
          { type: 'design', design: design('DAF3') },
        ],
      });
    }
    return send(res, 404, { code: 'endpoint_not_found', message: `${req.method} ${api}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    issue,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
