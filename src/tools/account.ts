import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openBrowser } from '../canva/auth.js';
import { resolveShortlink } from '../canva/ids.js';
import type { Job } from '../canva/rest.js';
import { errorMessage, sleep } from '../util.js';
import { JOB_KINDS, JOB_PATHS, finishJob, guarded, json, toolName, type ToolDeps } from './common.js';

async function account(deps: ToolDeps) {
  const settle = async <T>(p: Promise<T>) => p.then((value) => ({ value }), (err) => ({ error: errorMessage(err) }));
  const [me, profile, capabilities] = await Promise.all([
    settle(deps.rest.get<{ team_user: { user_id: string; team_id: string } }>('/v1/users/me')),
    settle(deps.rest.get<{ profile: { display_name?: string } }>('/v1/users/me/profile')),
    settle(deps.rest.get<{ capabilities?: string[] }>('/v1/users/me/capabilities')),
  ]);
  return {
    user: 'value' in me ? me.value.team_user : { error: me.error },
    displayName: 'value' in profile ? profile.value.profile.display_name : undefined,
    capabilities: 'value' in capabilities ? (capabilities.value.capabilities ?? []) : { error: capabilities.error },
  };
}

export function registerAccountTools(server: McpServer, deps: ToolDeps) {
  const n = (base: Parameters<typeof toolName>[1]) => toolName(deps.config.toolPrefix, base);

  server.registerTool(
    n('whoami'),
    {
      title: 'Who am I',
      description:
        'Returns whether this server is signed in to Canva, the user and team IDs, display name, and the account\'s API capabilities ' +
        '(autofill, brand_template, resize, design_generation, image_generation, background_removal...), plus the scopes granted and the tool prefix. ' +
        `Use it when a tool fails with an auth, permission or plan error. If it reports not signed in, call ${n('login')}.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => {
      const auth = await deps.auth.status();
      const details = auth.signedIn ? await account(deps) : undefined;
      return {
        content: [
          json({
            auth,
            ...details,
            requestedScopes: deps.config.scopes,
            redirectUri: deps.config.redirectUri,
            toolPrefix: deps.config.toolPrefix,
          }),
        ],
      };
    }),
  );

  server.registerTool(
    n('login'),
    {
      title: 'Sign in to Canva',
      description:
        'Signs this server in to the user\'s Canva account with OAuth. Opens the Canva sign-in page in the browser and waits for the user to approve access. ' +
        'Only the user can complete the sign-in: show them the returned URL if the browser did not open. Tokens are saved locally and renewed automatically, so this is needed once, ' +
        'or again after changing scopes in the Developer Portal.',
      inputSchema: {
        force: z.boolean().optional().describe('Sign in again even if already signed in (e.g. to pick up newly enabled scopes or switch accounts).'),
        waitSeconds: z.number().int().min(0).max(240).optional().describe('How long to wait for the user to finish signing in before returning. Defaults to 120.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const before = await deps.auth.status();
      if (before.signedIn && !args.force) {
        return { content: [json({ status: 'already_signed_in', ...(await account(deps)), note: 'Pass force: true to sign in again.' })] };
      }
      const pending = await deps.auth.startLogin();
      openBrowser(pending.url);
      const waitMs = (args.waitSeconds ?? 120) * 1000;
      const outcome = await Promise.race([
        pending.done.then(() => 'done' as const),
        sleep(waitMs).then(() => 'waiting' as const),
      ]);
      if (outcome === 'waiting') {
        return {
          content: [
            json({
              status: 'waiting_for_user',
              signInUrl: pending.url,
              next: `Ask the user to open signInUrl, sign in to Canva and click Allow. The sign-in stays open for 5 minutes; then call ${n('whoami')} to confirm.`,
            }),
          ],
        };
      }
      return { content: [json({ status: 'signed_in', ...(await account(deps)) })] };
    }),
  );

  server.registerTool(
    n('resolve-shortlink'),
    {
      title: 'Resolve shortlink',
      description: 'Expands a canva.link short link (e.g. from a share message) to the canva.com URL it points at, and extracts the design ID when it is a design link.',
      inputSchema: {
        url: z.string().min(1).describe('The short link, e.g. https://canva.link/abc123.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => ({ content: [json(await resolveShortlink(args.url))] })),
  );

  server.registerTool(
    n('get-job'),
    {
      title: 'Get job status',
      description:
        'Checks an asynchronous Canva job (export, import, upload, autofill, resize, merge, generation...) that another tool returned as still in progress, ' +
        'waiting up to waitSeconds for it to finish. Returns the finished result (e.g. export download URLs or the new design) or the current status.',
      inputSchema: {
        kind: z.enum(JOB_KINDS).describe('The job kind, exactly as the tool that started it reported.'),
        jobId: z.string().min(1).describe('The job ID that tool reported.'),
        waitSeconds: z.number().int().min(0).max(120).optional().describe('How long to keep polling before returning. Defaults to 30.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const { job } = await deps.rest.get<{ job: Job }>(JOB_PATHS[args.kind](args.jobId));
      return finishJob(deps, args.kind, { ...job, id: job.id ?? args.jobId }, undefined, (args.waitSeconds ?? 30) * 1000);
    }),
  );
}
