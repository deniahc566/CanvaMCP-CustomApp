import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { designId } from '../canva/ids.js';
import { continuationParam, designIdParam, guarded, json, toolName, type ToolDeps } from './common.js';

const messageParam = z
  .string()
  .min(1)
  .max(2048)
  .describe('Plain-text message. Mention someone with [user_id:team_id] (IDs from whoami or an earlier thread).');

const threadIdParam = z.string().min(1).describe('The comment thread ID (returned when the comment was created, or from get-comment-thread).');

const path = (design: string, thread?: string) =>
  `/v1/designs/${encodeURIComponent(designId(design))}/comments${thread ? `/${encodeURIComponent(thread)}` : ''}`;

export function registerCommentTools(server: McpServer, deps: ToolDeps) {
  const n = (base: Parameters<typeof toolName>[1]) => toolName(deps.config.toolPrefix, base);
  const { rest } = deps;

  server.registerTool(
    n('comment-on-design'),
    {
      title: 'Comment on design',
      description: 'Adds a new comment thread to a design, optionally assigning it to someone (who must also be mentioned in the message). (Canva preview API.)',
      inputSchema: {
        designId: designIdParam,
        message: messageParam,
        assigneeId: z.string().optional().describe('User ID to assign the comment to. Mention the same user in the message.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.post<{ thread: unknown }>(path(args.designId), { message_plaintext: args.message, assignee_id: args.assigneeId });
      return { content: [json(res.thread)] };
    }),
  );

  server.registerTool(
    n('reply-to-comment'),
    {
      title: 'Reply to comment',
      description: 'Replies to a comment thread on a design. (Canva preview API.)',
      inputSchema: { designId: designIdParam, threadId: threadIdParam, message: messageParam },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.post<{ reply: unknown }>(`${path(args.designId, args.threadId)}/replies`, { message_plaintext: args.message });
      return { content: [json(res.reply)] };
    }),
  );

  server.registerTool(
    n('get-comment-thread'),
    {
      title: 'Get comment thread',
      description: 'Gets one comment thread on a design: its text (or suggested edits), author, assignee, resolver and mentions. (Canva preview API.)',
      inputSchema: { designId: designIdParam, threadId: threadIdParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ thread?: unknown; comment?: unknown }>(path(args.designId, args.threadId));
      return { content: [json(res.thread ?? res.comment)] };
    }),
  );

  server.registerTool(
    n('list-replies'),
    {
      title: 'List replies',
      description: 'Lists the replies in a comment thread on a design, oldest first. (Canva preview API.)',
      inputSchema: {
        designId: designIdParam,
        threadId: threadIdParam,
        limit: z.number().int().min(1).max(100).optional().describe('Replies per page (default 50).'),
        continuation: continuationParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const res = await rest.get<{ items: unknown[]; continuation?: string }>(`${path(args.designId, args.threadId)}/replies`, {
        limit: args.limit,
        continuation: args.continuation,
      });
      return { content: [json({ replies: res.items, continuation: res.continuation })] };
    }),
  );
}
